import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

type ProductRow = {
  code: string;
  name: string;
  valeur: number;
  operations: number;
  dossiers: number;
  averageAmount: number;
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
    code: asString(row.code),
    name: asString(row.name),
    valeur: asNumber(row.valeur),
    operations: asNumber(row.operations),
    dossiers: asNumber(row.dossiers),
    averageAmount: asNumber(row.averageAmount),
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
      `detail:recouvrement:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

WITH Recouvrements AS (
  SELECT
    LEFT(cp.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT AS agencyCode,
    cp.NUM_DOSSIER COLLATE DATABASE_DEFAULT AS NUM_DOSSIER,
    cp.NUM_TRANS COLLATE DATABASE_DEFAULT AS NUM_TRANS,
    CAST(ISNULL(cp.MONTANT, 0) AS MONEY) AS montantRecouvre,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName
  FROM CREDIT_PERTE cp
  LEFT JOIN PRETS p
    ON p.NUM_DOSSIER COLLATE DATABASE_DEFAULT = cp.NUM_DOSSIER COLLATE DATABASE_DEFAULT
  LEFT JOIN DEMPRET dp
    ON dp.REF_DEMANDE COLLATE DATABASE_DEFAULT = p.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD COLLATE DATABASE_DEFAULT = dp.COD_PRDT_CRD COLLATE DATABASE_DEFAULT
  WHERE LEFT(cp.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND cp.DATE_OPERATION >= @MonthStart
    AND cp.DATE_OPERATION <= @AsOfDate
),
SummaryRows AS (
  SELECT
    CAST('summary' AS varchar(10)) COLLATE DATABASE_DEFAULT AS rowType,
    CAST(0 AS int) AS rowOrder,
    a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    CONVERT(varchar(10), @MonthStart, 23) COLLATE DATABASE_DEFAULT AS monthStart,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS code,
    CAST(NULL AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    ISNULL(SUM(rec.montantRecouvre), 0) AS valeur,
    CAST(ISNULL(COUNT_BIG(rec.NUM_TRANS), 0) AS int) AS operations,
    CAST(ISNULL(COUNT(DISTINCT rec.NUM_DOSSIER), 0) AS int) AS dossiers,
    CAST(CASE WHEN COUNT_BIG(rec.NUM_TRANS) = 0 THEN 0 ELSE AVG(rec.montantRecouvre) END AS MONEY) AS averageAmount
  FROM AGENCE a
  LEFT JOIN Recouvrements rec
    ON rec.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
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
    CONVERT(varchar(10), @MonthStart, 23) COLLATE DATABASE_DEFAULT AS monthStart,
    productCode AS code,
    CAST(productName AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    SUM(montantRecouvre) AS valeur,
    CAST(COUNT_BIG(NUM_TRANS) AS int) AS operations,
    CAST(COUNT(DISTINCT NUM_DOSSIER) AS int) AS dossiers,
    AVG(montantRecouvre) AS averageAmount
  FROM Recouvrements
  GROUP BY productCode, productName
)
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, monthStart, code, name, valeur, operations, dossiers, averageAmount
FROM SummaryRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, monthStart, code, name, valeur, operations, dossiers, averageAmount
FROM ProductRows
ORDER BY rowOrder, valeur DESC, name;
`);

    return (result.recordset ?? []) as SqlRow[];
      },
      undefined,
      { forceRefresh },
    );
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
        indicator: "recouvrement",
        label: "Recouvrement",
        unit: "currency",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        monthStart: asString(summary.monthStart),
        total: asNumber(summary.valeur),
        operations: asNumber(summary.operations),
        dossiers: asNumber(summary.dossiers),
        averageAmount: asNumber(summary.averageAmount),
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
    console.error(`[detail/recouvrement/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
