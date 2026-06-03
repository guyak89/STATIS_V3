import { NextResponse } from "next/server";
import sql from "mssql";
import {
  getPublicAgencySettings,
} from "@/lib/agency-settings";
import {
  addAgencyScopeInputs,
  agencyScopeSql,
  filterRowsByAgencyScope,
  publicAgencyScope,
  resolveAgencyScope,
  type AgencyScope,
} from "@/lib/agency-profiles";
import { CASH_OPERATIONS_CTE } from "@/lib/cash-operations-sql";
import { CREDIT_LOSS_TRANSFER_CTE } from "@/lib/credit-loss-transfer-sql";
import { CREDIT_LOSS_STOCK_CTE } from "@/lib/credit-loss-stock-sql";
import { getPool } from "@/lib/db";
import { MOBILE_MONEY_CTE } from "@/lib/mobile-money-sql";
import { getObjectifs, LOWER_IS_BETTER } from "@/lib/objectifs";
import { sqlCache } from "@/lib/sql-cache";
import { TREASURY_CTE } from "@/lib/treasury-sql";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type MssqlPool = InstanceType<typeof sql.ConnectionPool>;
type MssqlRequest = ReturnType<MssqlPool["request"]>;

/* ══════════════════════════════════════════════════════════════════════
   CONFIG — label, unité et requête SQL pour chaque indicateur
   Chaque requête retourne : agencyCode, agencyName, valeur, [count], [rate]
══════════════════════════════════════════════════════════════════════ */

type IndicatorConfig = {
  label: string;
  unit: "currency" | "count" | "percent";
  hasRate?: boolean;
  query: string;
};

function addAgencyInputs(request: MssqlRequest, scope: AgencyScope) {
  return addAgencyScopeInputs(request, scope);
}

function addDetailInputs(request: MssqlRequest, scope: AgencyScope, asOfDate: string | null) {
  return addAsOfDateInput(addAgencyInputs(request, scope), asOfDate);
}

function detailScopeCachePart(scope: AgencyScope): string {
  return scope.profileActive
    ? `profile-${scope.activeProfile?.id ?? "unknown"}-${scope.agencyCodes.join("_")}`
    : `${scope.centralAgencyCode}:${scope.includeCentralAgency ? "with-faitiere" : "without-faitiere"}`;
}

const LOAN_CTEAS_DETAIL = `
${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);
`;

const PORTFOLIO_CTEAS = `
WITH DeclassementRanked AS (
  SELECT dh.NUM_DOSSIER, dh.COD_TYP_OPERAT,
    ROW_NUMBER() OVER (PARTITION BY dh.NUM_DOSSIER ORDER BY dh.DATE_DECLAS_HIST DESC, dh.NUM_TRANS DESC) AS rn
  FROM DECLAS_HIST dh
  WHERE dh.DATE_DECLAS_HIST <= @AsOfDate AND (dh.DATE_FIN IS NULL OR dh.DATE_FIN > @AsOfDate)
),
LossLoans AS (
  SELECT dr.NUM_DOSSIER FROM DeclassementRanked dr WHERE dr.rn=1 AND dr.COD_TYP_OPERAT='TRPE'
),
FutureLossTransfers AS (
  SELECT DISTINCT dh.NUM_DOSSIER
  FROM DECLAS_HIST dh
  WHERE dh.COD_TYP_OPERAT='TRPE'
    AND dh.DATE_DECLAS_HIST>@AsOfDate
),
Remboursements AS (
  SELECT rb.NUM_DOSSIER, SUM(CAST(ISNULL(rb.CAPITAL_REMB,0) AS MONEY)) AS capitalRembourse
  FROM REMBOURS rb
  WHERE rb.DATE_REMB <= @AsOfDate
  GROUP BY rb.NUM_DOSSIER
),
LoanPortfolio AS (
  SELECT p.NUM_DOSSIER, LEFT(p.NUM_DOSSIER,3) AS agencyCode,
    CASE WHEN p.MONTANT_PRET-ISNULL(r.capitalRembourse,0)<0 THEN 0
         ELSE p.MONTANT_PRET-ISNULL(r.capitalRembourse,0) END AS currentOutstanding
  FROM PRETS p LEFT JOIN Remboursements r ON r.NUM_DOSSIER=p.NUM_DOSSIER
  WHERE ((p.ETAT_PRET IN ('SO','DC') AND (p.DATE_SOLDE IS NULL OR p.DATE_SOLDE>@AsOfDate))
      OR (p.ETAT_PRET='SD' AND p.DATE_SOLDE>@AsOfDate)
      OR (p.ETAT_PRET='PE' AND EXISTS (
          SELECT 1 FROM FutureLossTransfers flt WHERE flt.NUM_DOSSIER=p.NUM_DOSSIER
      )))
    AND p.NUM_DOSSIER LIKE '%PRT%'
    AND EXISTS (SELECT 1 FROM DECAIS dc WHERE dc.NUM_DOSSIER=p.NUM_DOSSIER AND dc.DATE_DECAIS<=@AsOfDate)
    AND NOT EXISTS (SELECT 1 FROM LossLoans ll WHERE ll.NUM_DOSSIER=p.NUM_DOSSIER)
    AND ${agencyScopeSql("LEFT(p.NUM_DOSSIER, 3)")}
)
`;

function buildParAgencyQuery(thresholdDays: 1 | 30 | 90) {
  const overdueCondition = thresholdDays === 1
    ? "t.DATE_ECHEANCE < @AsOfDate"
    : `t.DATE_ECHEANCE <= DATEADD(DAY, -${thresholdDays}, @AsOfDate)`;

  return `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
${PORTFOLIO_CTEAS}
,ActiveLoanPortfolio AS (
  SELECT *
  FROM LoanPortfolio
  WHERE currentOutstanding > 0
),
DueCapital AS (
  SELECT
    t.NUM_DOSSIER,
    SUM(CAST(ISNULL(t.CAPITAL, 0) AS MONEY)) AS capitalEchu
  FROM TABAMOR t
  JOIN ActiveLoanPortfolio lp
    ON lp.NUM_DOSSIER = t.NUM_DOSSIER
  WHERE ${overdueCondition}
  GROUP BY t.NUM_DOSSIER
),
LoanRisk AS (
  SELECT
    lp.agencyCode,
    lp.NUM_DOSSIER,
    lp.currentOutstanding,
    CASE WHEN ISNULL(dc.capitalEchu, 0) > ISNULL(r.capitalRembourse, 0) THEN 1 ELSE 0 END AS isRisk
  FROM ActiveLoanPortfolio lp
  LEFT JOIN DueCapital dc
    ON dc.NUM_DOSSIER = lp.NUM_DOSSIER
  LEFT JOIN Remboursements r
    ON r.NUM_DOSSIER = lp.NUM_DOSSIER
),
ParAgg AS (
  SELECT
    agencyCode,
    SUM(CAST(ISNULL(currentOutstanding, 0) AS MONEY)) AS totalPortfolio,
    SUM(CAST(CASE WHEN isRisk = 1 THEN ISNULL(currentOutstanding, 0) ELSE 0 END AS MONEY)) AS parAmount,
    CAST(SUM(CASE WHEN isRisk = 1 THEN 1 ELSE 0 END) AS bigint) AS riskLoans
  FROM LoanRisk
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(pa.parAmount, 0) AS valeur,
  CASE WHEN ISNULL(pa.totalPortfolio, 0) = 0 THEN 0
       ELSE 100.0 * ISNULL(pa.parAmount, 0) / pa.totalPortfolio END AS rate,
  ISNULL(pa.totalPortfolio, 0) AS totalPortfolio,
  ISNULL(pa.riskLoans, 0) AS count
FROM AGENCE a
LEFT JOIN ParAgg pa
  ON pa.agencyCode = a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`;
}

const INDICATORS: Record<string, IndicatorConfig> = {

  /* ── Adhésions (nouvelles adhésions du mois) ─────────────── */
  adhesions: {
    label: "Nouvelles Adhésions",
    unit: "count",
    query: `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);
WITH NewAdh AS (
  SELECT adh.COD_AGENCE,
    CAST(COUNT_BIG(*) AS bigint) AS nouvelles,
    CAST(COUNT_BIG(*) AS bigint) AS [count]
  FROM ADHERENT adh
  WHERE adh.DATE_INSCRIP >= @MonthStart
    AND adh.DATE_INSCRIP < DATEADD(DAY, 1, @AsOfDate)
    AND ${agencyScopeSql("adh.COD_AGENCE")}
  GROUP BY adh.COD_AGENCE
),
TotalAdh AS (
  SELECT adh.COD_AGENCE, CAST(COUNT_BIG(*) AS bigint) AS total
  FROM ADHERENT adh
  WHERE ${agencyScopeSql("adh.COD_AGENCE")}
  GROUP BY adh.COD_AGENCE
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(na.nouvelles, 0) AS valeur,
  ISNULL(na.[count], 0)   AS [count],
  ISNULL(ta.total, 0)     AS totalStock
FROM AGENCE a
LEFT JOIN NewAdh  na ON na.COD_AGENCE = a.COD_AGENCE
LEFT JOIN TotalAdh ta ON ta.COD_AGENCE = a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Encours Crédit ─────────────────────────────────────── */
  "encours-credit": {
    label: "Encours Crédit",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
${PORTFOLIO_CTEAS}
,LoanAgg AS (
  SELECT agencyCode, COUNT_BIG(*) AS loans, SUM(CAST(ISNULL(currentOutstanding,0) AS MONEY)) AS valeur
  FROM LoanPortfolio GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(la.valeur, 0) AS valeur,
  CAST(ISNULL(la.loans, 0) AS bigint) AS count
FROM AGENCE a LEFT JOIN LoanAgg la ON la.agencyCode = a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Encours Épargne ────────────────────────────────────── */
  "encours-epargne": {
    label: "Encours Épargne",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
WITH SavingsAccounts AS (
  SELECT
    ce.NUM_CPTE COLLATE DATABASE_DEFAULT AS accountNumber,
    c.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode
  FROM COMPTES_EPG ce
  JOIN COMPTES c
    ON c.NUM_CPTE COLLATE DATABASE_DEFAULT = ce.NUM_CPTE COLLATE DATABASE_DEFAULT
  WHERE (ce.DATE_CLOTURE IS NULL OR ce.DATE_CLOTURE > @AsOfDate)
    AND (c.DATE_CLOTURE IS NULL OR c.DATE_CLOTURE > @AsOfDate)
    AND ${agencyScopeSql("c.COD_AGENCE")}

  UNION

  SELECT
    cd.NUM_CPTE COLLATE DATABASE_DEFAULT AS accountNumber,
    c.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode
  FROM COMPTES_DAT cd
  JOIN COMPTES c
    ON c.NUM_CPTE COLLATE DATABASE_DEFAULT = cd.NUM_CPTE COLLATE DATABASE_DEFAULT
  WHERE (cd.DATE_CLOTURE IS NULL OR cd.DATE_CLOTURE > @AsOfDate)
    AND (c.DATE_CLOTURE IS NULL OR c.DATE_CLOTURE > @AsOfDate)
    AND ${agencyScopeSql("c.COD_AGENCE")}

  UNION

  SELECT
    tc.NUM_CMPTE COLLATE DATABASE_DEFAULT AS accountNumber,
    tc.CODE_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode
  FROM T_COMPTES tc
  WHERE (tc.DATE_CLOTURE IS NULL OR tc.DATE_CLOTURE > @AsOfDate)
    AND (tc.ETAT_CLOTURE IS NULL OR tc.ETAT_CLOTURE = 0 OR tc.DATE_CLOTURE > @AsOfDate)
    AND ${agencyScopeSql("tc.CODE_AGENCE")}

  UNION

  SELECT
    c.NUM_CPTE COLLATE DATABASE_DEFAULT AS accountNumber,
    c.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode
  FROM COMPTES c
  WHERE c.CPTE_GAL = '251214'
    AND (c.DATE_CLOTURE IS NULL OR c.DATE_CLOTURE > @AsOfDate)
    AND ${agencyScopeSql("c.COD_AGENCE")}
),
SavingsAccountBalances AS (
  SELECT
    sa.agencyCode,
    sa.accountNumber,
    SUM(CAST(CASE
      WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0)
      WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS, 0)
      ELSE 0
    END AS MONEY)) AS balance
  FROM SavingsAccounts sa
  LEFT JOIN HDPM h
    ON h.NUM_CPTE COLLATE DATABASE_DEFAULT = sa.accountNumber COLLATE DATABASE_DEFAULT
   AND h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
   AND ISNULL(h.COD_TYP_OPERAT, '') <> 'REPR'
  GROUP BY sa.agencyCode, sa.accountNumber
),
SavingsAgg AS (
  SELECT
    agencyCode,
    SUM(CAST(ISNULL(balance, 0) AS MONEY)) AS valeur,
    COUNT_BIG(*) AS [count]
  FROM SavingsAccountBalances
  WHERE agencyCode IS NOT NULL
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(sa.valeur, 0) AS valeur,
  CAST(ISNULL(sa.[count], 0) AS bigint) AS count
FROM AGENCE a
LEFT JOIN SavingsAgg sa
  ON sa.agencyCode COLLATE DATABASE_DEFAULT = a.COD_AGENCE COLLATE DATABASE_DEFAULT
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── PAR à 1 Jour ───────────────────────────────────────── */
  "par-1j": {
    label: "PAR à 1 Jour",
    unit: "currency",
    hasRate: true,
    query: buildParAgencyQuery(1),
  },

  /* ── PAR à 30 Jours ─────────────────────────────────────── */
  "par-30j": {
    label: "PAR à 30 Jours",
    unit: "currency",
    hasRate: true,
    query: buildParAgencyQuery(30),
  },

  /* ── PAR à 90 Jours ─────────────────────────────────────── */
  "par-90j": {
    label: "PAR à 90 Jours",
    unit: "currency",
    hasRate: true,
    query: buildParAgencyQuery(90),
  },

  /* ── Résultat ───────────────────────────────────────────── */
  resultat: {
    label: "Résultat",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
DECLARE @ExerciseStart date = DATEFROMPARTS(YEAR(@AsOfDate), 1, 1);
WITH ResultByAgency AS (
  SELECT
    c.COD_AGENCE,
    SUM(CAST(CASE
      WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0)
      WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS, 0)
      ELSE 0
    END AS MONEY)) AS valeur,
    COUNT_BIG(*) AS [count]
  FROM HDPM h
  JOIN COMPTES c
    ON c.NUM_CPTE COLLATE DATABASE_DEFAULT = h.NUM_CPTE COLLATE DATABASE_DEFAULT
  WHERE h.DATE_OPERATION >= @ExerciseStart
    AND h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
    AND (h.NUM_CPTE LIKE '7%' OR h.NUM_CPTE LIKE '6%')
    AND ${agencyScopeSql("c.COD_AGENCE")}
  GROUP BY c.COD_AGENCE
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(r.valeur, 0) AS valeur,
  CAST(ISNULL(r.[count], 0) AS bigint) AS [count]
FROM AGENCE a LEFT JOIN ResultByAgency r ON r.COD_AGENCE=a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Collecte Tontine ───────────────────────────────────── */
  "tontine-collecte": {
    label: "Volume Collecte Tontine",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(SUM(CAST(CASE WHEN op.TYPE_OP = 'A' THEN -ISNULL(op.MONTANT_OP,0) ELSE ISNULL(op.MONTANT_OP,0) END AS MONEY)), 0) AS valeur,
  CAST(ISNULL(COUNT_BIG(op.ID_OP), 0) AS bigint) AS count
FROM AGENCE a
LEFT JOIN COMPTES c ON c.COD_AGENCE COLLATE DATABASE_DEFAULT = a.COD_AGENCE COLLATE DATABASE_DEFAULT
LEFT JOIN T_OPERATION op ON op.NUM_CMPTE COLLATE DATABASE_DEFAULT = c.NUM_CPTE COLLATE DATABASE_DEFAULT
  AND op.TYPE_OP IN ('D','C','A')
  AND op.DATE_VALIDATION >= @MonthStart
  AND op.DATE_VALIDATION < DATEADD(DAY, 1, @AsOfDate)
WHERE ${agencyScopeSql("a.COD_AGENCE")}
GROUP BY a.COD_AGENCE, a.RAISON_SOCIAL
ORDER BY valeur DESC;`,
  },

  /* ── Décaissements ──────────────────────────────────────── */
  "operations-caisse": {
    label: "Opérations de caisse",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
WITH
${CASH_OPERATIONS_CTE},
CashAgg AS (
  SELECT
    agencyCode,
    SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS MONEY)) AS cashInAmount,
    SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)) AS cashOutAmount,
    CAST(COUNT_BIG(*) AS bigint) AS count
  FROM CashOperations
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(ca.cashInAmount, 0) + ISNULL(ca.cashOutAmount, 0) AS valeur,
  ISNULL(ca.cashInAmount, 0) AS cashInAmount,
  ISNULL(ca.cashOutAmount, 0) AS cashOutAmount,
  ISNULL(ca.count, 0) AS count
FROM AGENCE a
LEFT JOIN CashAgg ca
  ON ca.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  "mobile-money": {
    label: "Mobile Money",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
WITH
${MOBILE_MONEY_CTE},
MobileMoneyAgg AS (
  SELECT
    agencyCode,
    SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS MONEY)) AS cashInAmount,
    SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)) AS cashOutAmount,
    CAST(COUNT_BIG(*) AS bigint) AS count
  FROM MobileMoneyOperations
  WHERE agencyCode IS NOT NULL
    AND ${agencyScopeSql("agencyCode")}
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(mma.cashInAmount, 0) + ISNULL(mma.cashOutAmount, 0) AS valeur,
  ISNULL(mma.cashInAmount, 0) AS cashInAmount,
  ISNULL(mma.cashOutAmount, 0) AS cashOutAmount,
  ISNULL(mma.count, 0) AS count
FROM AGENCE a
LEFT JOIN MobileMoneyAgg mma
  ON mma.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  tresorerie: {
    label: "Trésorerie",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
WITH
${TREASURY_CTE},
TreasuryAgg AS (
  SELECT
    agencyCode,
    SUM(CAST(CASE WHEN treasuryType = 'cash' THEN balance ELSE 0 END AS MONEY)) AS cashInAmount,
    SUM(CAST(CASE WHEN treasuryType = 'bank' THEN balance ELSE 0 END AS MONEY)) AS cashOutAmount,
    CAST(COUNT_BIG(*) AS bigint) AS count
  FROM TreasuryBalances
  WHERE agencyCode IS NOT NULL
    AND ${agencyScopeSql("agencyCode")}
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(ta.cashInAmount, 0) + ISNULL(ta.cashOutAmount, 0) AS valeur,
  ISNULL(ta.cashInAmount, 0) AS cashInAmount,
  ISNULL(ta.cashOutAmount, 0) AS cashOutAmount,
  ISNULL(ta.count, 0) AS count
FROM AGENCE a
LEFT JOIN TreasuryAgg ta
  ON ta.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  decaissements: {
    label: "Décaissements",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
WITH DecaisAgg AS (
  SELECT LEFT(d.NUM_DOSSIER,3) AS agencyCode,
    SUM(CAST(ISNULL(d.MONTANT_DECAIS,0) AS MONEY)) AS valeur,
    CAST(COUNT_BIG(*) AS bigint) AS count
  FROM DECAIS d
  WHERE d.DATE_DECAIS >= @MonthStart
    AND d.DATE_DECAIS <= @AsOfDate
    AND ${agencyScopeSql("LEFT(d.NUM_DOSSIER, 3)")}
  GROUP BY LEFT(d.NUM_DOSSIER,3)
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(da.valeur, 0) AS valeur,
  ISNULL(da.count, 0)  AS count
FROM AGENCE a LEFT JOIN DecaisAgg da ON da.agencyCode=a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Impayés ────────────────────────────────────────────── */
  impayes: {
    label: "Impayés",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
WITH DueCapital AS (
  SELECT t.NUM_DOSSIER,
    SUM(CAST(ISNULL(t.CAPITAL,0) AS MONEY)) AS capitalEchu
  FROM TABAMOR t
  WHERE t.DATE_ECHEANCE < @AsOfDate
  GROUP BY t.NUM_DOSSIER
),
PaidCapital AS (
  SELECT rb.NUM_DOSSIER,
    SUM(CAST(ISNULL(rb.CAPITAL_REMB,0) AS MONEY)) AS capitalRembourse
  FROM REMBOURS rb
  WHERE rb.DATE_REMB <= @AsOfDate
  GROUP BY rb.NUM_DOSSIER
),
LossDates AS (
  SELECT dh.NUM_DOSSIER,
    MAX(dh.DATE_DECLAS_HIST) AS dateDeclasPerte,
    COUNT_BIG(*) AS trpeCount
  FROM DECLAS_HIST dh
  WHERE dh.COD_TYP_OPERAT = 'TRPE'
  GROUP BY dh.NUM_DOSSIER
),
EligibleLoans AS (
  SELECT p.NUM_DOSSIER, LEFT(p.NUM_DOSSIER, 3) AS agencyCode
  FROM PRETS p
  LEFT JOIN LossDates ld ON ld.NUM_DOSSIER = p.NUM_DOSSIER
  WHERE p.COD_SRCEFIN NOT IN ('02','07')
    AND ${agencyScopeSql("LEFT(p.NUM_DOSSIER, 3)")}
    AND (
      (p.ETAT_PRET IN ('DC','SO') AND ISNULL(ld.trpeCount, 0) = 0)
      OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
      OR (p.ETAT_PRET = 'PE' AND ld.dateDeclasPerte > @AsOfDate)
    )
),
PastDue AS (
  SELECT el.agencyCode,
    el.NUM_DOSSIER,
    CASE
      WHEN ISNULL(dc.capitalEchu, 0) - ISNULL(pc.capitalRembourse, 0) > 0
      THEN ISNULL(dc.capitalEchu, 0) - ISNULL(pc.capitalRembourse, 0)
      ELSE 0
    END AS impayeCapital
  FROM EligibleLoans el
  LEFT JOIN DueCapital dc ON dc.NUM_DOSSIER = el.NUM_DOSSIER
  LEFT JOIN PaidCapital pc ON pc.NUM_DOSSIER = el.NUM_DOSSIER
),
ImpayesAgg AS (
  SELECT agencyCode,
    SUM(CAST(ISNULL(impayeCapital, 0) AS MONEY)) AS valeur,
    CAST(SUM(CASE WHEN impayeCapital > 0 THEN 1 ELSE 0 END) AS bigint) AS count
  FROM PastDue
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(ia.valeur, 0) AS valeur,
  ISNULL(ia.count,  0) AS count
FROM AGENCE a LEFT JOIN ImpayesAgg ia ON ia.agencyCode=a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Stock Crédit en Perte ──────────────────────────────── */
  "stock-perte": {
    label: "Stock Crédit en Perte",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
WITH ${CREDIT_LOSS_STOCK_CTE},
PerteAgg AS (
  SELECT
    agencyCode,
    SUM(CAST(ISNULL(stockAmount, 0) AS MONEY)) AS valeur,
    CAST(COUNT_BIG(*) AS bigint) AS count
  FROM CreditLossStock
  WHERE ${agencyScopeSql("agencyCode")}
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(pa.valeur, 0) AS valeur,
  ISNULL(pa.count,  0) AS count
FROM AGENCE a LEFT JOIN PerteAgg pa ON pa.agencyCode=a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Transféré en Perte (période) ───────────────────────── */
  "transfere-perte": {
    label: "Transféré en Perte sur la Période",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
WITH ${CREDIT_LOSS_TRANSFER_CTE},
PerteAgg AS (
  SELECT
    agencyCode,
    SUM(CAST(ISNULL(transferredAmount,0) AS MONEY)) AS valeur,
    CAST(COUNT_BIG(DISTINCT numDossier) AS bigint) AS count
  FROM CreditLossTransfers
  WHERE ${agencyScopeSql("agencyCode")}
  GROUP BY agencyCode
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(pa.valeur, 0) AS valeur,
  ISNULL(pa.count,  0) AS count
FROM AGENCE a LEFT JOIN PerteAgg pa ON pa.agencyCode=a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Recouvrement ───────────────────────────────────────── */
  recouvrement: {
    label: "Recouvrement de Crédit",
    unit: "currency",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
WITH RecAgg AS (
  SELECT LEFT(cp.NUM_DOSSIER,3) AS agencyCode,
    SUM(CAST(ISNULL(cp.MONTANT,0) AS MONEY)) AS valeur,
    CAST(COUNT_BIG(*) AS bigint) AS count
  FROM CREDIT_PERTE cp
  WHERE cp.DATE_OPERATION >= @MonthStart
    AND cp.DATE_OPERATION <= @AsOfDate
    AND ${agencyScopeSql("LEFT(cp.NUM_DOSSIER, 3)")}
  GROUP BY LEFT(cp.NUM_DOSSIER,3)
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(ra.valeur, 0) AS valeur,
  ISNULL(ra.count,  0) AS count
FROM AGENCE a LEFT JOIN RecAgg ra ON ra.agencyCode=a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },

  /* ── Souscriptions Tontine ──────────────────────────────── */
  "souscriptions-tontine": {
    label: "Souscriptions Tontine",
    unit: "count",
    query: `
SET NOCOUNT ON;
${LOAN_CTEAS_DETAIL}
WITH SouscAgg AS (
  SELECT ta.CODE_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(COUNT_BIG(*) AS bigint) AS valeur
  FROM T_ADHERENT ta
  WHERE ta.DATE_INSCRIPT_ADHE >= @MonthStart
    AND ta.DATE_INSCRIPT_ADHE <= @AsOfDate
    AND ${agencyScopeSql("ta.CODE_AGENCE")}
  GROUP BY ta.CODE_AGENCE COLLATE DATABASE_DEFAULT
)
SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(sa.valeur, 0) AS valeur,
  ISNULL(sa.valeur, 0) AS count
FROM AGENCE a LEFT JOIN SouscAgg sa ON sa.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY valeur DESC;`,
  },
};

/* ══════════════════════════════════════════════════════════════════════
   TREND QUERY — tendance mensuelle des nouvelles adhésions (12 mois)
══════════════════════════════════════════════════════════════════════ */

const TREND_QUERY_ADHESIONS = `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
SELECT
  FORMAT(DATEFROMPARTS(YEAR(a.DATE_INSCRIP), MONTH(a.DATE_INSCRIP), 1), 'yyyy-MM') AS label,
  CAST(COUNT_BIG(*) AS int) AS total
FROM ADHERENT a
WHERE a.DATE_INSCRIP >= DATEADD(MONTH, -12, @AsOfDate)
  AND a.DATE_INSCRIP < DATEADD(DAY, 1, @AsOfDate)
  AND ${agencyScopeSql("a.COD_AGENCE")}
GROUP BY DATEFROMPARTS(YEAR(a.DATE_INSCRIP), MONTH(a.DATE_INSCRIP), 1)
ORDER BY 1;`;

/* ══════════════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════════════ */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ indicator: string }> },
) {
  const { indicator } = await params;
  const config = INDICATORS[indicator];

  if (!config) {
    return NextResponse.json(
      { error: `Indicateur inconnu : "${indicator}"` },
      { status: 404 },
    );
  }

  try {
    const requestedAsOfDate = parseAsOfDateParam(req);
    const scope = resolveAgencyScope(req);
    const agencySettings = {
      ...getPublicAgencySettings(),
      ...publicAgencyScope(scope),
    };
    const forceRefresh = new URL(req.url).searchParams.has("refresh");
    const detailData = await sqlCache(
      `detail:${indicator}:${detailScopeCachePart(scope)}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
        const pool = await getPool();
        const [result, trendResult] = await Promise.all([
          addDetailInputs(pool.request(), scope, requestedAsOfDate).query(config.query),
          indicator === "adhesions"
            ? addDetailInputs(pool.request(), scope, requestedAsOfDate).query(TREND_QUERY_ADHESIONS)
            : Promise.resolve(null),
        ]);

        return {
          rows: (result.recordset ?? []) as Array<Record<string, unknown>>,
          trend: (trendResult?.recordset ?? null) as Array<Record<string, unknown>> | null,
        };
      },
      undefined,
      { forceRefresh },
    );

    const rows = filterRowsByAgencyScope(detailData.rows, scope);
    const total = rows.reduce(
      (s: number, r: Record<string, unknown>) => s + Number(r.valeur ?? 0),
      0,
    );

    // Objectifs par agence pour cet indicateur
    const { global: globalObjectifs, agence: agenceObjectifs } = getObjectifs();
    const objectifGlobal = globalObjectifs[indicator] ?? null;
    const objectifAgence = Object.fromEntries(
      Object.entries(agenceObjectifs)
        .map(([agencyCode, values]) => [agencyCode, values[indicator]] as const)
        .filter((entry): entry is readonly [string, number] => {
          const value = entry[1];
          return value !== undefined && value !== null && !Number.isNaN(Number(value));
        }),
    );
    const hasObjectifs = objectifGlobal !== null || Object.keys(objectifAgence).length > 0;

    // Enrichir chaque ligne avec son objectif agence
    const enrichedRows = rows.map((r: Record<string, unknown>) => {
      const code = String(r.agencyCode ?? "");
      const agenceObj = objectifAgence[code] ?? null;
      return { ...r, objectif: agenceObj };
    });

    const lowerIsBetter = LOWER_IS_BETTER.has(indicator);

    return NextResponse.json(
      {
        indicator,
        label: config.label,
        unit: config.unit,
        hasRate: config.hasRate ?? false,
        lowerIsBetter,
        total,
        objectifGlobal,
        objectifAgence,
        hasObjectifs,
        agencySettings,
        rows: enrichedRows,
        trend: detailData.trend,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    console.error(`[detail/${indicator}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
