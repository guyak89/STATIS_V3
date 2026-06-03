import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";
import { CREDIT_LOSS_TRANSFER_CTE } from "@/lib/credit-loss-transfer-sql";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

type ProductRow = {
  code: string;
  name: string;
  valeur: number;
  dossiers: number;
  grossOutstanding: number;
  guaranteesDeducted: number;
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
    dossiers: asNumber(row.dossiers),
    grossOutstanding: asNumber(row.grossOutstanding),
    guaranteesDeducted: asNumber(row.guaranteesDeducted),
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
      `detail:transfere-perte:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

WITH ${CREDIT_LOSS_TRANSFER_CTE},
TransfersWithProduct AS (
  SELECT
    clt.agencyCode,
    clt.numDossier,
    clt.grossOutstanding,
    clt.cautionAmount + clt.epgAmount AS guaranteesDeducted,
    clt.transferredAmount,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName
  FROM CreditLossTransfers clt
  LEFT JOIN PRETS p
    ON p.NUM_DOSSIER COLLATE DATABASE_DEFAULT = clt.numDossier COLLATE DATABASE_DEFAULT
  LEFT JOIN DEMPRET dp
    ON dp.REF_DEMANDE COLLATE DATABASE_DEFAULT = p.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD COLLATE DATABASE_DEFAULT = dp.COD_PRDT_CRD COLLATE DATABASE_DEFAULT
  WHERE clt.agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
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
    ISNULL(SUM(twp.transferredAmount), 0) AS valeur,
    CAST(ISNULL(COUNT(DISTINCT twp.numDossier), 0) AS int) AS dossiers,
    ISNULL(SUM(twp.grossOutstanding), 0) AS grossOutstanding,
    ISNULL(SUM(twp.guaranteesDeducted), 0) AS guaranteesDeducted,
    CAST(CASE WHEN COUNT(DISTINCT twp.numDossier) = 0 THEN 0 ELSE AVG(twp.transferredAmount) END AS money) AS averageAmount
  FROM AGENCE a
  LEFT JOIN TransfersWithProduct twp
    ON twp.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
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
    SUM(transferredAmount) AS valeur,
    CAST(COUNT(DISTINCT numDossier) AS int) AS dossiers,
    SUM(grossOutstanding) AS grossOutstanding,
    SUM(guaranteesDeducted) AS guaranteesDeducted,
    AVG(transferredAmount) AS averageAmount
  FROM TransfersWithProduct
  GROUP BY productCode, productName
)
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, monthStart, code, name, valeur, dossiers, grossOutstanding, guaranteesDeducted, averageAmount
FROM SummaryRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, monthStart, code, name, valeur, dossiers, grossOutstanding, guaranteesDeducted, averageAmount
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
        indicator: "transfere-perte",
        label: "Transfere en Perte",
        unit: "currency",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        monthStart: asString(summary.monthStart),
        total: asNumber(summary.valeur),
        dossiers: asNumber(summary.dossiers),
        grossOutstanding: asNumber(summary.grossOutstanding),
        guaranteesDeducted: asNumber(summary.guaranteesDeducted),
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
    console.error(`[detail/transfere-perte/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
