/**
 * lib/dashboard-overview.ts
 *
 * La carte "overview" du tableau de bord était calculée par UNE seule requête
 * monolithique (~25 CTE) qui dépassait systématiquement le requestTimeout de
 * 300 s — ce qui faisait échouer tout l'endpoint /api/dashboard (Promise.all),
 * donc AUCUN indicateur ne s'affichait.
 *
 * Ici, cette requête est découpée en blocs indépendants exécutés en parallèle
 * et tolérants aux pannes (voir app/api/dashboard/route.ts). Chaque bloc produit
 * un sous-ensemble des colonnes de l'objet Overview ; route.ts les fusionne.
 *
 * Optimisations appliquées vs la requête d'origine (résultats identiques,
 * vérifiés contre la base) :
 *  - Bloc "loans" : matérialisation des parties partagées en tables #temp pour
 *    éviter la ré-évaluation des CTE référencés plusieurs fois (>5 min → ~25 s).
 *  - Bloc "treasury"/"tontine"/"result" : suppression des COLLATE DATABASE_DEFAULT
 *    sur les clés de jointure. Toutes les colonnes texte de la base sont déjà en
 *    French_CI_AS (= collation par défaut), donc ces COLLATE étaient des no-op qui
 *    empêchaient l'optimiseur d'utiliser les index (seek → scan).
 */
import { agencyScopeSql } from "@/lib/agency-profiles";
import { AS_OF_DATE_SQL } from "@/lib/as-of-date";
import { CASH_OPERATIONS_CTE } from "@/lib/cash-operations-sql";
import { MOBILE_MONEY_CTE } from "@/lib/mobile-money-sql";
import { CREDIT_LOSS_STOCK_CTE } from "@/lib/credit-loss-stock-sql";
import { CREDIT_LOSS_TRANSFER_CTE } from "@/lib/credit-loss-transfer-sql";

const HEAD = `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);
DECLARE @ExerciseStart date = DATEFROMPARTS(YEAR(@AsOfDate), 1, 1);
`;

/** Métadonnées + compteurs mono-table (rapides). */
const metaCountsSql = `${HEAD}
SELECT
  CONVERT(varchar(20), GETDATE(), 120)  AS asOf,
  CONVERT(varchar(10), @OpenDate, 120)  AS openDate,
  CONVERT(varchar(10), @AsOfDate, 120)  AS operationalDate,
  CAST(CASE WHEN @RequestedAsOfDate IS NULL THEN 0 ELSE 1 END AS bit) AS isHistorical,
  CONVERT(varchar(7),  @AsOfDate, 126)  AS periodLabel,
  (SELECT COUNT_BIG(*) FROM ADHERENT a WHERE ${agencyScopeSql("a.COD_AGENCE")}) AS totalAdherents,
  (SELECT COUNT_BIG(*) FROM ADHERENT a WHERE a.DATE_INSCRIP >= @MonthStart AND a.DATE_INSCRIP < DATEADD(DAY, 1, @AsOfDate) AND ${agencyScopeSql("a.COD_AGENCE")}) AS newAdherentsPeriod,
  (SELECT COUNT_BIG(*) FROM AGENCE a WHERE ${agencyScopeSql("a.COD_AGENCE")}) AS activeAgencies,
  (SELECT COUNT_BIG(*) FROM T_ADHERENT ta WHERE ta.DATE_INSCRIPT_ADHE >= @MonthStart AND ta.DATE_INSCRIPT_ADHE <= @AsOfDate AND ${agencyScopeSql("ta.CODE_AGENCE")}) AS tontineSubscriptionsPeriod,
  (SELECT SUM(CAST(ISNULL(d.MONTANT_DECAIS,0) AS MONEY)) FROM DECAIS d WHERE d.DATE_DECAIS >= @MonthStart AND d.DATE_DECAIS <= @AsOfDate AND ${agencyScopeSql("LEFT(d.NUM_DOSSIER,3)")}) AS decaissementsPeriod,
  (SELECT COUNT_BIG(*) FROM DECAIS d WHERE d.DATE_DECAIS >= @MonthStart AND d.DATE_DECAIS <= @AsOfDate AND ${agencyScopeSql("LEFT(d.NUM_DOSSIER,3)")}) AS decaissementsCount,
  (SELECT SUM(CAST(ISNULL(cp.MONTANT,0) AS MONEY)) FROM CREDIT_PERTE cp WHERE cp.DATE_OPERATION >= @MonthStart AND cp.DATE_OPERATION <= @AsOfDate AND ${agencyScopeSql("LEFT(cp.NUM_DOSSIER,3)")}) AS creditRecoveryPeriod,
  (SELECT COUNT_BIG(*) FROM CREDIT_PERTE cp WHERE cp.DATE_OPERATION >= @MonthStart AND cp.DATE_OPERATION <= @AsOfDate AND ${agencyScopeSql("LEFT(cp.NUM_DOSSIER,3)")}) AS creditRecoveryCount;`;

/**
 * Portefeuille de crédit : PAR (1j/30j/90j) + impayés.
 * Les parties partagées sont matérialisées en #temp pour ne les calculer
 * qu'une seule fois (vs ré-évaluation des CTE dans la requête d'origine).
 */
const loansSql = `${HEAD}

-- Remboursements en capital (= ImpayesPaidCapital de la requête d'origine)
SELECT rb.NUM_DOSSIER, SUM(CAST(ISNULL(rb.CAPITAL_REMB,0) AS MONEY)) AS capitalRembourse
INTO #Remb FROM REMBOURS rb WHERE rb.DATE_REMB <= @AsOfDate GROUP BY rb.NUM_DOSSIER;
CREATE CLUSTERED INDEX ix ON #Remb(NUM_DOSSIER);

-- Dossiers dont le dernier déclassement est un transfert en perte (exclus du portefeuille)
SELECT NUM_DOSSIER INTO #Loss FROM (
  SELECT dh.NUM_DOSSIER, dh.COD_TYP_OPERAT,
    ROW_NUMBER() OVER (PARTITION BY dh.NUM_DOSSIER ORDER BY dh.DATE_DECLAS_HIST DESC, dh.NUM_TRANS DESC) AS rn
  FROM DECLAS_HIST dh
  WHERE dh.DATE_DECLAS_HIST <= @AsOfDate AND (dh.DATE_FIN IS NULL OR dh.DATE_FIN > @AsOfDate)
) x WHERE x.rn = 1 AND x.COD_TYP_OPERAT = 'TRPE';
CREATE CLUSTERED INDEX ix ON #Loss(NUM_DOSSIER);

-- Transferts en perte postérieurs à la date (réintègrent les prêts 'PE')
SELECT DISTINCT dh.NUM_DOSSIER INTO #Future FROM DECLAS_HIST dh
WHERE dh.COD_TYP_OPERAT = 'TRPE' AND dh.DATE_DECLAS_HIST > @AsOfDate;
CREATE CLUSTERED INDEX ix ON #Future(NUM_DOSSIER);

-- Dates de passage en perte par dossier (éligibilité impayés)
SELECT dh.NUM_DOSSIER, MAX(dh.DATE_DECLAS_HIST) AS dateDeclasPerte, COUNT_BIG(*) AS trpeCount
INTO #LossDates FROM DECLAS_HIST dh WHERE dh.COD_TYP_OPERAT = 'TRPE' GROUP BY dh.NUM_DOSSIER;
CREATE CLUSTERED INDEX ix ON #LossDates(NUM_DOSSIER);

-- Portefeuille actif (encours > 0)
SELECT p.NUM_DOSSIER,
  CASE WHEN p.MONTANT_PRET - ISNULL(r.capitalRembourse,0) < 0 THEN 0
       ELSE p.MONTANT_PRET - ISNULL(r.capitalRembourse,0) END AS currentOutstanding
INTO #Active
FROM PRETS p LEFT JOIN #Remb r ON r.NUM_DOSSIER = p.NUM_DOSSIER
WHERE (   (p.ETAT_PRET IN ('SO','DC') AND (p.DATE_SOLDE IS NULL OR p.DATE_SOLDE > @AsOfDate))
       OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
       OR (p.ETAT_PRET = 'PE' AND EXISTS (SELECT 1 FROM #Future f WHERE f.NUM_DOSSIER = p.NUM_DOSSIER)))
  AND p.NUM_DOSSIER LIKE '%PRT%'
  AND EXISTS (SELECT 1 FROM DECAIS dc WHERE dc.NUM_DOSSIER = p.NUM_DOSSIER AND dc.DATE_DECAIS <= @AsOfDate)
  AND NOT EXISTS (SELECT 1 FROM #Loss ll WHERE ll.NUM_DOSSIER = p.NUM_DOSSIER)
  AND ${agencyScopeSql("LEFT(p.NUM_DOSSIER, 3)")};
DELETE FROM #Active WHERE currentOutstanding <= 0;
CREATE CLUSTERED INDEX ix ON #Active(NUM_DOSSIER);

-- Capital échu par seuil (portefeuille actif) → PAR
SELECT t.NUM_DOSSIER,
  SUM(CAST(CASE WHEN t.DATE_ECHEANCE < @AsOfDate THEN ISNULL(t.CAPITAL,0) ELSE 0 END AS MONEY)) AS e1,
  SUM(CAST(CASE WHEN t.DATE_ECHEANCE <= DATEADD(DAY,-30,@AsOfDate) THEN ISNULL(t.CAPITAL,0) ELSE 0 END AS MONEY)) AS e30,
  SUM(CAST(CASE WHEN t.DATE_ECHEANCE <= DATEADD(DAY,-90,@AsOfDate) THEN ISNULL(t.CAPITAL,0) ELSE 0 END AS MONEY)) AS e90
INTO #Due FROM TABAMOR t JOIN #Active a ON a.NUM_DOSSIER = t.NUM_DOSSIER
WHERE t.DATE_ECHEANCE < @AsOfDate GROUP BY t.NUM_DOSSIER;
CREATE CLUSTERED INDEX ix ON #Due(NUM_DOSSIER);

-- Prêts éligibles au calcul des impayés
SELECT p.NUM_DOSSIER INTO #ImpEligible
FROM PRETS p LEFT JOIN #LossDates ld ON ld.NUM_DOSSIER = p.NUM_DOSSIER
WHERE p.COD_SRCEFIN NOT IN ('02','07') AND ${agencyScopeSql("LEFT(p.NUM_DOSSIER, 3)")}
  AND ( (p.ETAT_PRET IN ('DC','SO') AND ISNULL(ld.trpeCount,0) = 0)
     OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
     OR (p.ETAT_PRET = 'PE' AND ld.dateDeclasPerte > @AsOfDate) );
CREATE CLUSTERED INDEX ix ON #ImpEligible(NUM_DOSSIER);

-- Capital échu des prêts éligibles
SELECT t.NUM_DOSSIER, SUM(CAST(ISNULL(t.CAPITAL,0) AS MONEY)) AS capitalEchu
INTO #ImpDue FROM TABAMOR t JOIN #ImpEligible e ON e.NUM_DOSSIER = t.NUM_DOSSIER
WHERE t.DATE_ECHEANCE < @AsOfDate GROUP BY t.NUM_DOSSIER;
CREATE CLUSTERED INDEX ix ON #ImpDue(NUM_DOSSIER);

SELECT
  par.totalLoanAmount, par.par1Amount, par.par30Amount, par.par90Amount,
  par.par1Rate, par.par30Rate, par.par90Rate,
  imp.totalImpayes
FROM (
  SELECT
    SUM(CAST(ISNULL(a.currentOutstanding,0) AS MONEY)) AS totalLoanAmount,
    SUM(CAST(CASE WHEN ISNULL(d.e1,0)  > ISNULL(r.capitalRembourse,0) THEN a.currentOutstanding ELSE 0 END AS MONEY)) AS par1Amount,
    SUM(CAST(CASE WHEN ISNULL(d.e30,0) > ISNULL(r.capitalRembourse,0) THEN a.currentOutstanding ELSE 0 END AS MONEY)) AS par30Amount,
    SUM(CAST(CASE WHEN ISNULL(d.e90,0) > ISNULL(r.capitalRembourse,0) THEN a.currentOutstanding ELSE 0 END AS MONEY)) AS par90Amount,
    CASE WHEN SUM(CAST(ISNULL(a.currentOutstanding,0) AS float)) = 0 THEN 0
      ELSE 100.0 * SUM(CASE WHEN ISNULL(d.e1,0)  > ISNULL(r.capitalRembourse,0) THEN CAST(a.currentOutstanding AS float) ELSE 0 END) / SUM(CAST(ISNULL(a.currentOutstanding,0) AS float)) END AS par1Rate,
    CASE WHEN SUM(CAST(ISNULL(a.currentOutstanding,0) AS float)) = 0 THEN 0
      ELSE 100.0 * SUM(CASE WHEN ISNULL(d.e30,0) > ISNULL(r.capitalRembourse,0) THEN CAST(a.currentOutstanding AS float) ELSE 0 END) / SUM(CAST(ISNULL(a.currentOutstanding,0) AS float)) END AS par30Rate,
    CASE WHEN SUM(CAST(ISNULL(a.currentOutstanding,0) AS float)) = 0 THEN 0
      ELSE 100.0 * SUM(CASE WHEN ISNULL(d.e90,0) > ISNULL(r.capitalRembourse,0) THEN CAST(a.currentOutstanding AS float) ELSE 0 END) / SUM(CAST(ISNULL(a.currentOutstanding,0) AS float)) END AS par90Rate
  FROM #Active a
  LEFT JOIN #Due  d ON d.NUM_DOSSIER = a.NUM_DOSSIER
  LEFT JOIN #Remb r ON r.NUM_DOSSIER = a.NUM_DOSSIER
) par
CROSS JOIN (
  SELECT SUM(CAST(CASE WHEN ISNULL(dc.capitalEchu,0) - ISNULL(pc.capitalRembourse,0) > 0
                       THEN ISNULL(dc.capitalEchu,0) - ISNULL(pc.capitalRembourse,0) ELSE 0 END AS MONEY)) AS totalImpayes
  FROM #ImpEligible e
  LEFT JOIN #ImpDue dc ON dc.NUM_DOSSIER = e.NUM_DOSSIER
  LEFT JOIN #Remb  pc ON pc.NUM_DOSSIER = e.NUM_DOSSIER
) imp;

DROP TABLE #Remb, #Loss, #Future, #LossDates, #Active, #Due, #ImpEligible, #ImpDue;`;

/** Résultat (comptes de classe 6 et 7) — sans COLLATE inutile sur la jointure HDPM. */
const resultSql = `${HEAD}
SELECT ISNULL(SUM(CAST(CASE
    WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS,0)
    WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS,0)
    ELSE 0 END AS money)), 0) AS totalResult
FROM HDPM h JOIN COMPTES c ON c.NUM_CPTE = h.NUM_CPTE
WHERE h.DATE_OPERATION >= @ExerciseStart AND h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
  AND (h.NUM_CPTE LIKE '7%' OR h.NUM_CPTE LIKE '6%')
  AND ${agencyScopeSql("c.COD_AGENCE")};`;

/** Collecte tontine du mois — sans COLLATE inutile sur la jointure COMPTES. */
const tontineSql = `${HEAD}
SELECT
  ISNULL(SUM(CAST(CASE WHEN op.TYPE_OP = 'A' THEN -ISNULL(op.MONTANT_OP,0) ELSE ISNULL(op.MONTANT_OP,0) END AS money)), 0) AS tontineCollectionPeriod,
  COUNT_BIG(*) AS tontineDepositsCount
FROM T_OPERATION op JOIN COMPTES c ON c.NUM_CPTE = op.NUM_CMPTE
WHERE op.TYPE_OP IN ('D','C','A')
  AND op.DATE_VALIDATION >= @MonthStart
  AND op.DATE_VALIDATION < DATEADD(DAY, 1, @AsOfDate)
  AND ${agencyScopeSql("c.COD_AGENCE")};`;

/** Stock de pertes + transferts en perte du mois. */
const creditLossSql = `${HEAD}
WITH ${CREDIT_LOSS_STOCK_CTE},
${CREDIT_LOSS_TRANSFER_CTE}
SELECT
  ISNULL((SELECT SUM(CAST(ISNULL(cls.stockAmount,0) AS MONEY)) FROM CreditLossStock cls WHERE ${agencyScopeSql("cls.agencyCode")}), 0) AS stockCreditLoss,
  ISNULL((SELECT SUM(CAST(ISNULL(clt.transferredAmount,0) AS MONEY)) FROM CreditLossTransfers clt WHERE ${agencyScopeSql("clt.agencyCode")}), 0) AS creditTransferredToLossPeriod,
  ISNULL((SELECT COUNT_BIG(DISTINCT clt.numDossier) FROM CreditLossTransfers clt WHERE ${agencyScopeSql("clt.agencyCode")}), 0) AS creditTransferredToLossCount;`;

/** Opérations de caisse du jour (agrégats). */
const cashSql = `${HEAD}
WITH ${CASH_OPERATIONS_CTE}
SELECT
  ISNULL(SUM(CAST(CASE WHEN direction = 'IN'  THEN amount ELSE 0 END AS MONEY)), 0) AS cashInAmount,
  ISNULL(SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)), 0) AS cashOutAmount,
  COUNT_BIG(*) AS cashOperationsCount
FROM CashOperations;`;

/** Mobile money du jour (agrégats). */
const mobileSql = `${HEAD}
WITH ${MOBILE_MONEY_CTE}
SELECT
  ISNULL(SUM(CAST(CASE WHEN direction = 'IN'  THEN amount ELSE 0 END AS MONEY)), 0) AS mobileMoneyDepositAmount,
  ISNULL(SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)), 0) AS mobileMoneyWithdrawalAmount,
  COUNT_BIG(*) AS mobileMoneyOperationsCount
FROM MobileMoneyOperations
WHERE agencyCode IS NOT NULL AND ${agencyScopeSql("agencyCode")};`;

/**
 * Trésorerie (caisses + banques) — version sans COLLATE sur la jointure HDPM
 * (28 M lignes) pour permettre le seek d'index. Résultat identique à la requête
 * d'origine (vérifié), ~2× plus rapide.
 */
const treasurySql = `${HEAD}
;WITH TreasuryAccounts AS (
  SELECT DISTINCT
    CAST(ca.COD_AGENCE AS varchar(20)) AS agencyCode,
    CAST(ca.NUM_CPTE   AS varchar(22)) AS accountNumber,
    CAST('cash' AS varchar(20))        AS treasuryType
  FROM dbo.CAIS_AGENCE ca WITH (NOLOCK)
  JOIN dbo.COMPTES c WITH (NOLOCK) ON c.NUM_CPTE = ca.NUM_CPTE
  WHERE ca.NUM_CPTE IS NOT NULL
    AND NULLIF(LTRIM(RTRIM(ca.NUM_CPTE)), '') IS NOT NULL
    AND (c.DATE_CLOTURE IS NULL OR c.DATE_CLOTURE > @AsOfDate)
  UNION
  SELECT DISTINCT
    CAST(c.COD_AGENCE AS varchar(20)),
    CAST(c.NUM_CPTE   AS varchar(22)),
    CAST('bank' AS varchar(20))
  FROM dbo.COMPTES c WITH (NOLOCK)
  WHERE c.COD_AGENCE IS NOT NULL AND c.NUM_CPTE IS NOT NULL
    AND (c.CPTE_GAL LIKE '1111212%' OR c.CPTE_GAL LIKE '1131%' OR c.CPTE_GAL LIKE '1141%')
    AND (c.DATE_CLOTURE IS NULL OR c.DATE_CLOTURE > @AsOfDate)
),
TreasuryBalances AS (
  SELECT ta.agencyCode, ta.treasuryType,
    SUM(CAST(CASE
      WHEN h.SENS_OPERATION = 'D' THEN ISNULL(h.MONTANT_TRANS,0)
      WHEN h.SENS_OPERATION = 'C' THEN -ISNULL(h.MONTANT_TRANS,0)
      ELSE 0 END AS money)) AS balance
  FROM TreasuryAccounts ta
  LEFT JOIN dbo.HDPM h WITH (NOLOCK)
    ON h.NUM_CPTE = ta.accountNumber
   AND h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
   AND ISNULL(h.COD_TYP_OPERAT, '') <> 'REPR'
  GROUP BY ta.agencyCode, ta.treasuryType
)
SELECT
  ISNULL(SUM(CAST(CASE WHEN treasuryType = 'cash' THEN balance ELSE 0 END AS MONEY)), 0) AS treasuryCashAmount,
  ISNULL(SUM(CAST(CASE WHEN treasuryType = 'bank' THEN balance ELSE 0 END AS MONEY)), 0) AS treasuryBankAmount,
  ISNULL(SUM(CAST(balance AS MONEY)), 0) AS treasuryTotalAmount
FROM TreasuryBalances
WHERE agencyCode IS NOT NULL AND ${agencyScopeSql("agencyCode")};`;

/**
 * Encours d'épargne (total sur le périmètre).
 *
 * Volontairement EXCLU de OVERVIEW_PARTS : c'est l'indicateur le plus lourd
 * (rejeu du grand livre HDPM — 28 M lignes — pour ~220 000 comptes d'épargne,
 * ~170 s). route.ts le calcule en arrière-plan, non bloquant, avec un cache
 * long ; le tableau de bord reste rapide et l'épargne s'affiche peu après.
 * C'est l'intention d'origine (« Calcul détaillé hors chargement initial »).
 *
 * Univers identique à la page de détail encours-épargne (familles EPG + DAT +
 * tontine), agrégé sur le périmètre, sans COLLATE inutile. Le solde de chaque
 * compte = somme signée de ses écritures HDPM ; valeur vérifiée identique à la
 * méthode de la page de détail.
 */
export const SAVINGS_SQL = `${HEAD}
SELECT DISTINCT accountNumber INTO #SavAcc FROM (
  SELECT ce.NUM_CPTE AS accountNumber,
    CASE WHEN ce.DATE_CLOTURE IS NULL THEN c.DATE_CLOTURE WHEN c.DATE_CLOTURE IS NULL THEN ce.DATE_CLOTURE
      WHEN ce.DATE_CLOTURE < c.DATE_CLOTURE THEN ce.DATE_CLOTURE ELSE c.DATE_CLOTURE END AS closureDate
  FROM COMPTES_EPG ce JOIN COMPTES c ON c.NUM_CPTE = ce.NUM_CPTE WHERE ${agencyScopeSql("c.COD_AGENCE")}
  UNION
  SELECT cd.NUM_CPTE,
    CASE WHEN cd.DATE_CLOTURE IS NULL THEN c.DATE_CLOTURE WHEN c.DATE_CLOTURE IS NULL THEN cd.DATE_CLOTURE
      WHEN cd.DATE_CLOTURE < c.DATE_CLOTURE THEN cd.DATE_CLOTURE ELSE c.DATE_CLOTURE END
  FROM COMPTES_DAT cd JOIN COMPTES c ON c.NUM_CPTE = cd.NUM_CPTE WHERE ${agencyScopeSql("c.COD_AGENCE")}
  UNION
  SELECT tc.NUM_CMPTE, tc.DATE_CLOTURE FROM T_COMPTES tc WHERE ${agencyScopeSql("tc.CODE_AGENCE")}
  UNION
  SELECT c.NUM_CPTE, c.DATE_CLOTURE FROM COMPTES c WHERE c.CPTE_GAL = '251214' AND ${agencyScopeSql("c.COD_AGENCE")}
) u WHERE u.closureDate IS NULL OR u.closureDate > @AsOfDate;
CREATE CLUSTERED INDEX ix ON #SavAcc(accountNumber);

SELECT
  ISNULL(SUM(CAST(CASE
    WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0)
    WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS, 0)
    ELSE 0 END AS MONEY)), 0) AS totalSavingsAmount,
  CONVERT(varchar(10), @AsOfDate, 23) AS savingsSnapshotPeriod
FROM HDPM h WITH (NOLOCK)
JOIN #SavAcc s ON s.accountNumber = h.NUM_CPTE
WHERE h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
  AND ISNULL(h.COD_TYP_OPERAT, '') <> 'REPR';

DROP TABLE #SavAcc;`;

export type OverviewPart = { label: string; sql: string };

/** Les blocs sont exécutés en parallèle et tolérants aux pannes par route.ts. */
export const OVERVIEW_PARTS: OverviewPart[] = [
  { label: "overview:meta",       sql: metaCountsSql },
  { label: "overview:loans",      sql: loansSql },
  { label: "overview:result",     sql: resultSql },
  { label: "overview:tontine",    sql: tontineSql },
  { label: "overview:creditLoss", sql: creditLossSql },
  { label: "overview:cash",       sql: cashSql },
  { label: "overview:mobile",     sql: mobileSql },
  { label: "overview:treasury",   sql: treasurySql },
];

/**
 * Valeurs neutres garantissant que l'objet Overview a toujours toutes ses clés,
 * même si un bloc échoue (dégradation gracieuse côté UI).
 */
export const OVERVIEW_DEFAULTS = {
  asOf: "",
  openDate: "",
  operationalDate: "",
  isHistorical: false,
  periodLabel: "",
  totalAdherents: 0,
  newAdherentsPeriod: 0,
  activeAgencies: 0,
  totalLoanAmount: 0,
  totalSavingsAmount: null as number | null,
  savingsSnapshotPeriod: null as string | null,
  par1Amount: 0,
  par30Amount: 0,
  par90Amount: 0,
  par1Rate: 0,
  par30Rate: 0,
  par90Rate: 0,
  totalImpayes: 0,
  totalResult: 0,
  tontineCollectionPeriod: 0,
  tontineDepositsCount: 0,
  tontineSubscriptionsPeriod: 0,
  decaissementsPeriod: 0,
  decaissementsCount: 0,
  stockCreditLoss: 0,
  creditTransferredToLossPeriod: 0,
  creditTransferredToLossCount: 0,
  creditRecoveryPeriod: 0,
  creditRecoveryCount: 0,
  cashInAmount: 0,
  cashOutAmount: 0,
  cashOperationsCount: 0,
  mobileMoneyDepositAmount: 0,
  mobileMoneyWithdrawalAmount: 0,
  mobileMoneyOperationsCount: 0,
  treasuryCashAmount: 0,
  treasuryBankAmount: 0,
  treasuryTotalAmount: 0,
};
