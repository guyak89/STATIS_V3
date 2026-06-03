import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

type ProductRow = {
  productKey: string;
  familyCode: string;
  familyName: string;
  productCode: string;
  productName: string;
  valeur: number;
  accounts: number;
  averageBalance: number;
};

type TrendRow = {
  label: string;
  date: string;
  valeur: number;
};

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function normalizeAgencyCode(value: string): string {
  return decodeURIComponent(value).trim().toUpperCase();
}

function mapProductRows(rows: SqlRow[]): ProductRow[] {
  return rows.map((row) => ({
    productKey: asString(row.productKey),
    familyCode: asString(row.familyCode),
    familyName: asString(row.familyName),
    productCode: asString(row.productCode),
    productName: asString(row.productName),
    valeur: asNumber(row.valeur),
    accounts: asNumber(row.accounts),
    averageBalance: asNumber(row.averageBalance),
  }));
}

function mapTrendRows(rows: SqlRow[]): TrendRow[] {
  return rows.map((row) => ({
    label: asString(row.productName),
    date: asString(row.asOfDate),
    valeur: asNumber(row.valeur),
  }));
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agencyCode: string }> },
) {
  const { agencyCode: rawAgencyCode } = await params;
  const agencyCode = normalizeAgencyCode(rawAgencyCode ?? "");

  if (!/^[A-Z0-9]{3}$/.test(agencyCode)) {
    return NextResponse.json(
      { error: `Code agence invalide : "${agencyCode}"` },
      { status: 400 },
    );
  }

  const scope = resolveAgencyScope(req);
  if (!isAgencyAllowedByScope(agencyCode, scope)) {
    return NextResponse.json(
      { error: `Agence faitiere exclue par parametrage : "${agencyCode}"` },
      { status: 403 },
    );
  }

  try {
    const requestedAsOfDate = parseAsOfDateParam(req);
    const forceRefresh = new URL(req.url).searchParams.has("refresh");
    const rows = await sqlCache(
      `detail:encours-epargne:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
        const pool = await getPool();
        const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
          .input("AgencyCode", agencyCode)
          .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @ExerciseStart date = DATEFROMPARTS(YEAR(@AsOfDate), 1, 1);

-- 1) Univers des comptes d'épargne de l'agence, matérialisé UNE SEULE fois
--    (la requête d'origine recalculait ce CTE 3×). Sans COLLATE : toutes les
--    colonnes texte de la base sont déjà en French_CI_AS, donc les COLLATE
--    DATABASE_DEFAULT n'étaient que des no-op qui empêchaient les index.
SELECT familyCode, familyName, accountNumber, agencyCode, productCode, productName, closureDate
INTO #Universe
FROM (
  SELECT
    CAST('EPG' AS varchar(20)) AS familyCode,
    CAST(N'Epargne a vue / garantie' AS nvarchar(80)) AS familyName,
    ce.NUM_CPTE AS accountNumber,
    c.COD_AGENCE AS agencyCode,
    COALESCE(NULLIF(LTRIM(RTRIM(ce.COD_PRDT_EPG)), ''), 'N/A') AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pe.NOM_PRDT_EPG)), ''), N'Produit epargne non identifie') AS productName,
    CASE WHEN ce.DATE_CLOTURE IS NULL THEN c.DATE_CLOTURE
         WHEN c.DATE_CLOTURE IS NULL THEN ce.DATE_CLOTURE
         WHEN ce.DATE_CLOTURE < c.DATE_CLOTURE THEN ce.DATE_CLOTURE
         ELSE c.DATE_CLOTURE END AS closureDate
  FROM COMPTES_EPG ce
  JOIN COMPTES c ON c.NUM_CPTE = ce.NUM_CPTE
  LEFT JOIN PRDT_EPG pe ON pe.COD_PRDT_EPG = ce.COD_PRDT_EPG
  WHERE c.COD_AGENCE = @AgencyCode

  UNION

  SELECT
    CAST('DAT' AS varchar(20)),
    CAST(N'Depot a terme' AS nvarchar(80)),
    cd.NUM_CPTE,
    c.COD_AGENCE,
    CAST('DAT' AS varchar(40)),
    CAST(N'Depots a terme' AS nvarchar(160)),
    CASE WHEN cd.DATE_CLOTURE IS NULL THEN c.DATE_CLOTURE
         WHEN c.DATE_CLOTURE IS NULL THEN cd.DATE_CLOTURE
         WHEN cd.DATE_CLOTURE < c.DATE_CLOTURE THEN cd.DATE_CLOTURE
         ELSE c.DATE_CLOTURE END
  FROM COMPTES_DAT cd
  JOIN COMPTES c ON c.NUM_CPTE = cd.NUM_CPTE
  WHERE c.COD_AGENCE = @AgencyCode

  UNION

  SELECT
    CAST('TONTINE' AS varchar(20)),
    CAST(N'Epargne tontine' AS nvarchar(80)),
    tc.NUM_CMPTE,
    tc.CODE_AGENCE,
    COALESCE(NULLIF(LTRIM(RTRIM(tc.CODE_PRDT)), ''), 'N/A'),
    COALESCE(NULLIF(LTRIM(RTRIM(tp.NOM_PRDT)), ''), N'Produit tontine non identifie'),
    tc.DATE_CLOTURE
  FROM T_COMPTES tc
  LEFT JOIN T_PRODUIT tp ON tp.CODE_PRDT = tc.CODE_PRDT
  WHERE tc.CODE_AGENCE = @AgencyCode

  UNION

  SELECT
    CAST('TONTINE' AS varchar(20)),
    CAST(N'Epargne tontine' AS nvarchar(80)),
    c.NUM_CPTE,
    c.COD_AGENCE,
    CAST('251214' AS varchar(40)),
    CAST(N'Versement collecteur' AS nvarchar(160)),
    c.DATE_CLOTURE
  FROM COMPTES c
  WHERE c.COD_AGENCE = @AgencyCode AND c.CPTE_GAL = '251214'
) u;
CREATE CLUSTERED INDEX ix ON #Universe(accountNumber);

-- 2) Comptes ouverts à la date d'arrêté.
SELECT familyCode, familyName, accountNumber, agencyCode, productCode, productName
INTO #Open
FROM #Universe
WHERE closureDate IS NULL OR closureDate > @AsOfDate;
CREATE CLUSTERED INDEX ix ON #Open(accountNumber);

-- 3) Mouvements mensuels par compte — UN SEUL parcours de HDPM (l'origine en
--    faisait deux : un pour le solde, un pour la tendance). Le solde courant en
--    est dérivé (cumul), la tendance aussi.
SELECT
  u.accountNumber,
  DATEFROMPARTS(YEAR(h.DATE_OPERATION), MONTH(h.DATE_OPERATION), 1) AS monthStart,
  SUM(CAST(CASE
    WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0)
    WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS, 0)
    ELSE 0 END AS MONEY)) AS movement
INTO #Mvt
FROM #Universe u
JOIN HDPM h WITH (NOLOCK)
  ON h.NUM_CPTE = u.accountNumber
 AND h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
 AND ISNULL(h.COD_TYP_OPERAT, '') <> 'REPR'
GROUP BY u.accountNumber, DATEFROMPARTS(YEAR(h.DATE_OPERATION), MONTH(h.DATE_OPERATION), 1);
CREATE CLUSTERED INDEX ix ON #Mvt(accountNumber);

-- 4) Solde courant par compte ouvert = cumul de ses mouvements.
SELECT
  o.familyCode, o.familyName, o.accountNumber, o.agencyCode, o.productCode, o.productName,
  ISNULL(b.balance, 0) AS balance
INTO #Bal
FROM #Open o
LEFT JOIN (SELECT accountNumber, SUM(movement) AS balance FROM #Mvt GROUP BY accountNumber) b
  ON b.accountNumber = o.accountNumber;

;WITH MonthEnds AS (
  SELECT
    @ExerciseStart AS monthStart,
    CASE WHEN EOMONTH(@ExerciseStart) > @AsOfDate THEN @AsOfDate ELSE EOMONTH(@ExerciseStart) END AS monthEnd
  UNION ALL
  SELECT
    DATEADD(MONTH, 1, monthStart),
    CASE WHEN EOMONTH(DATEADD(MONTH, 1, monthStart)) > @AsOfDate THEN @AsOfDate ELSE EOMONTH(DATEADD(MONTH, 1, monthStart)) END
  FROM MonthEnds
  WHERE DATEADD(MONTH, 1, monthStart) <= @AsOfDate
),
MonthlyTrend AS (
  SELECT
    me.monthStart, me.monthEnd,
    ISNULL(SUM(mm.movement), 0) AS valeur
  FROM MonthEnds me
  JOIN #Universe sau ON sau.closureDate IS NULL OR sau.closureDate > me.monthEnd
  LEFT JOIN #Mvt mm ON mm.accountNumber = sau.accountNumber AND mm.monthStart <= me.monthStart
  GROUP BY me.monthStart, me.monthEnd
),
ProductAgg AS (
  SELECT
    familyCode, familyName, productCode, productName,
    SUM(CAST(ISNULL(balance, 0) AS MONEY)) AS valeur,
    COUNT_BIG(*) AS accounts,
    AVG(CAST(ISNULL(balance, 0) AS MONEY)) AS averageBalance
  FROM #Bal
  GROUP BY familyCode, familyName, productCode, productName
),
SummaryRows AS (
  SELECT
    CAST('summary' AS varchar(10)) AS rowType,
    CAST(0 AS int) AS rowOrder,
    a.COD_AGENCE AS agencyCode,
    a.RAISON_SOCIAL AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) AS asOfDate,
    CAST(NULL AS varchar(140)) AS productKey,
    CAST(NULL AS varchar(20)) AS familyCode,
    CAST(NULL AS nvarchar(80)) AS familyName,
    CAST(NULL AS varchar(40)) AS productCode,
    CAST(NULL AS nvarchar(160)) AS productName,
    ISNULL(SUM(b.balance), 0) AS valeur,
    CAST(ISNULL(COUNT_BIG(b.accountNumber), 0) AS bigint) AS accounts,
    CAST(CASE WHEN COUNT_BIG(b.accountNumber) = 0 THEN 0 ELSE AVG(CAST(ISNULL(b.balance, 0) AS MONEY)) END AS MONEY) AS averageBalance
  FROM AGENCE a
  LEFT JOIN #Bal b ON b.agencyCode = a.COD_AGENCE
  WHERE a.COD_AGENCE = @AgencyCode
  GROUP BY a.COD_AGENCE, a.RAISON_SOCIAL
),
ProductRows AS (
  SELECT
    CAST('product' AS varchar(10)) AS rowType,
    CAST(1 AS int) AS rowOrder,
    CAST(@AgencyCode AS varchar(3)) AS agencyCode,
    CAST(NULL AS nvarchar(120)) AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) AS asOfDate,
    (familyCode + ':' + productCode) AS productKey,
    familyCode,
    familyName,
    productCode,
    productName,
    valeur,
    CAST(accounts AS bigint) AS accounts,
    averageBalance
  FROM ProductAgg
),
TrendRows AS (
  SELECT
    CAST('trend' AS varchar(10)) AS rowType,
    CAST(2 AS int) AS rowOrder,
    CAST(@AgencyCode AS varchar(3)) AS agencyCode,
    CAST(NULL AS nvarchar(120)) AS agencyName,
    CONVERT(varchar(10), monthEnd, 23) AS asOfDate,
    CONVERT(char(7), monthEnd, 126) AS productKey,
    CAST(NULL AS varchar(20)) AS familyCode,
    CAST(NULL AS nvarchar(80)) AS familyName,
    CONVERT(char(7), monthEnd, 126) AS productCode,
    FORMAT(monthEnd, 'MMM yyyy', 'fr-FR') AS productName,
    valeur,
    CAST(0 AS bigint) AS accounts,
    CAST(0 AS money) AS averageBalance
  FROM MonthlyTrend
)
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, productKey, familyCode, familyName, productCode, productName, valeur, accounts, averageBalance
FROM SummaryRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, productKey, familyCode, familyName, productCode, productName, valeur, accounts, averageBalance
FROM ProductRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, productKey, familyCode, familyName, productCode, productName, valeur, accounts, averageBalance
FROM TrendRows
ORDER BY rowOrder, valeur DESC, productName;

DROP TABLE #Universe, #Open, #Mvt, #Bal;
`);

        return (result.recordset ?? []) as SqlRow[];
      },
      undefined,
      { forceRefresh },
    );

    const summaryRows = rows.filter((row) => asString(row.rowType) === "summary");
    const productRows = mapProductRows(rows.filter((row) => asString(row.rowType) === "product"));
    const trendRows = mapTrendRows(rows.filter((row) => asString(row.rowType) === "trend"))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (summaryRows.length === 0) {
      return NextResponse.json(
        { error: `Agence inconnue : "${agencyCode}"` },
        { status: 404 },
      );
    }

    const summary = summaryRows[0];

    return NextResponse.json(
      {
        indicator: "encours-epargne",
        label: "Encours epargne",
        unit: "currency",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        total: asNumber(summary.valeur),
        accounts: asNumber(summary.accounts),
        averageBalance: asNumber(summary.averageBalance),
        productRows,
        trendRows,
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
    console.error(`[detail/encours-epargne/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
