import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";
import { CREDIT_LOSS_STOCK_CTE } from "@/lib/credit-loss-stock-sql";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function normalizeAgencyCode(value: string): string {
  return decodeURIComponent(value).trim().toUpperCase();
}

function mapProductRows(rows: SqlRow[]) {
  return rows.map((row) => ({
    code: asString(row.code),
    name: asString(row.name),
    valeur: asNumber(row.valeur),
    dossiers: asNumber(row.dossiers),
    initialLossOutstanding: asNumber(row.initialLossOutstanding),
    recoveredAmount: asNumber(row.recoveredAmount),
    averageStock: asNumber(row.averageStock),
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
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH ${CREDIT_LOSS_STOCK_CTE},
StockWithProduct AS (
  SELECT
    cls.agencyCode,
    cls.numDossier,
    cls.initialLossOutstanding,
    cls.recoveredAmount,
    cls.stockAmount,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName
  FROM CreditLossStock cls
  LEFT JOIN PRETS p
    ON p.NUM_DOSSIER COLLATE DATABASE_DEFAULT = cls.numDossier COLLATE DATABASE_DEFAULT
  LEFT JOIN DEMPRET dp
    ON dp.REF_DEMANDE COLLATE DATABASE_DEFAULT = p.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD COLLATE DATABASE_DEFAULT = dp.COD_PRDT_CRD COLLATE DATABASE_DEFAULT
  WHERE cls.agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
),
SummaryRows AS (
  SELECT
    CAST('summary' AS varchar(10)) COLLATE DATABASE_DEFAULT AS rowType,
    CAST(0 AS int) AS rowOrder,
    a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS code,
    CAST(NULL AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    ISNULL(SUM(swp.stockAmount), 0) AS valeur,
    CAST(ISNULL(COUNT_BIG(swp.numDossier), 0) AS int) AS dossiers,
    ISNULL(SUM(swp.initialLossOutstanding), 0) AS initialLossOutstanding,
    ISNULL(SUM(swp.recoveredAmount), 0) AS recoveredAmount,
    CAST(CASE WHEN COUNT_BIG(swp.numDossier) = 0 THEN 0 ELSE AVG(swp.stockAmount) END AS money) AS averageStock
  FROM AGENCE a
  LEFT JOIN StockWithProduct swp
    ON swp.agencyCode COLLATE DATABASE_DEFAULT = a.COD_AGENCE COLLATE DATABASE_DEFAULT
  WHERE a.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
  GROUP BY a.COD_AGENCE, a.RAISON_SOCIAL
),
ProductRows AS (
  SELECT
    CAST('product' AS varchar(10)) COLLATE DATABASE_DEFAULT AS rowType,
    CAST(1 AS int) AS rowOrder,
    CAST(@AgencyCode AS varchar(3)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(NULL AS varchar(100)) COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    productCode AS code,
    CAST(productName AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    SUM(stockAmount) AS valeur,
    CAST(COUNT_BIG(numDossier) AS int) AS dossiers,
    SUM(initialLossOutstanding) AS initialLossOutstanding,
    SUM(recoveredAmount) AS recoveredAmount,
    AVG(stockAmount) AS averageStock
  FROM StockWithProduct
  GROUP BY productCode, productName
)
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, code, name, valeur, dossiers, initialLossOutstanding, recoveredAmount, averageStock
FROM SummaryRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, code, name, valeur, dossiers, initialLossOutstanding, recoveredAmount, averageStock
FROM ProductRows
ORDER BY rowOrder, valeur DESC, name;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const summaryRows = rows.filter((row) => asString(row.rowType) === "summary");
    const productRows = mapProductRows(rows.filter((row) => asString(row.rowType) === "product"));

    if (summaryRows.length === 0) {
      return NextResponse.json(
        { error: `Agence inconnue : "${agencyCode}"` },
        { status: 404 },
      );
    }

    const summary = summaryRows[0];

    return NextResponse.json(
      {
        indicator: "stock-perte",
        label: "Stock Credit en Perte",
        unit: "currency",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        total: asNumber(summary.valeur),
        dossiers: asNumber(summary.dossiers),
        initialLossOutstanding: asNumber(summary.initialLossOutstanding),
        recoveredAmount: asNumber(summary.recoveredAmount),
        averageStock: asNumber(summary.averageStock),
        productRows,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    console.error(`[detail/stock-perte/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
