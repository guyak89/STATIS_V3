import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

type BreakdownRow = {
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

function mapBreakdownRows(rows: SqlRow[]): BreakdownRow[] {
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
      `detail:decaissements:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

WITH Decaissements AS (
  SELECT
    LEFT(d.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT AS agencyCode,
    d.NUM_DOSSIER COLLATE DATABASE_DEFAULT AS NUM_DOSSIER,
    d.NUM_TRANS COLLATE DATABASE_DEFAULT AS NUM_TRANS,
    CAST(ISNULL(d.MONTANT_DECAIS, 0) AS MONEY) AS montantDecais,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_GEST)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS managerCode,
    COALESCE(
      NULLIF(
        LTRIM(RTRIM(CONCAT(
          ISNULL(g.NOM, ''),
          CASE
            WHEN NULLIF(LTRIM(RTRIM(g.PRENOM)), '') IS NULL THEN ''
            ELSE ' ' + LTRIM(RTRIM(g.PRENOM))
          END
        ))),
        ''
      ),
      'Gestionnaire non identifie'
    ) COLLATE DATABASE_DEFAULT AS managerName
  FROM DECAIS d
  JOIN PRETS p
    ON p.NUM_DOSSIER = d.NUM_DOSSIER
  JOIN DEMPRET dp
    ON dp.REF_DEMANDE = p.REF_DEMANDE
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD = dp.COD_PRDT_CRD
  LEFT JOIN GESTIONNAIRE g
    ON g.COD_GEST = dp.COD_GEST
  WHERE LEFT(d.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND d.DATE_DECAIS >= @MonthStart
    AND d.DATE_DECAIS <= @AsOfDate
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
    ISNULL(SUM(dec.montantDecais), 0) AS valeur,
    CAST(ISNULL(COUNT_BIG(dec.NUM_TRANS), 0) AS int) AS operations,
    CAST(ISNULL(COUNT(DISTINCT dec.NUM_DOSSIER), 0) AS int) AS dossiers,
    CAST(CASE WHEN COUNT_BIG(dec.NUM_TRANS) = 0 THEN 0 ELSE AVG(dec.montantDecais) END AS MONEY) AS averageAmount
  FROM AGENCE a
  LEFT JOIN Decaissements dec
    ON dec.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
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
    SUM(montantDecais) AS valeur,
    CAST(COUNT_BIG(NUM_TRANS) AS int) AS operations,
    CAST(COUNT(DISTINCT NUM_DOSSIER) AS int) AS dossiers,
    AVG(montantDecais) AS averageAmount
  FROM Decaissements
  GROUP BY productCode, productName
),
ManagerRows AS (
  SELECT
    CAST('manager' AS varchar(10)) COLLATE DATABASE_DEFAULT AS rowType,
    CAST(2 AS int) AS rowOrder,
    CAST(@AgencyCode AS varchar(3)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(NULL AS varchar(100)) COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    CONVERT(varchar(10), @MonthStart, 23) COLLATE DATABASE_DEFAULT AS monthStart,
    managerCode AS code,
    CAST(managerName AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    SUM(montantDecais) AS valeur,
    CAST(COUNT_BIG(NUM_TRANS) AS int) AS operations,
    CAST(COUNT(DISTINCT NUM_DOSSIER) AS int) AS dossiers,
    AVG(montantDecais) AS averageAmount
  FROM Decaissements
  GROUP BY managerCode, managerName
)
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, monthStart, code, name, valeur, operations, dossiers, averageAmount
FROM SummaryRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, monthStart, code, name, valeur, operations, dossiers, averageAmount
FROM ProductRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, monthStart, code, name, valeur, operations, dossiers, averageAmount
FROM ManagerRows
ORDER BY rowOrder, valeur DESC, name;
`);

    return (result.recordset ?? []) as SqlRow[];
      },
      undefined,
      { forceRefresh },
    );

    const summaryRows = rows.filter((row) => asString(row.rowType) === "summary");
    const productRows = mapBreakdownRows(rows.filter((row) => asString(row.rowType) === "product"));
    const managerRows = mapBreakdownRows(rows.filter((row) => asString(row.rowType) === "manager"));

    if (summaryRows.length === 0) {
      return NextResponse.json(
        { error: `Agence inconnue : "${agencyCode}"` },
        { status: 404 },
      );
    }

    const summary = summaryRows[0];

    return NextResponse.json(
      {
        indicator: "decaissements",
        label: "Decaissements",
        unit: "currency",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        monthStart: asString(summary.monthStart),
        total: asNumber(summary.valeur),
        operations: asNumber(summary.operations),
        dossiers: asNumber(summary.dossiers),
        productRows,
        managerRows,
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
    console.error(`[detail/decaissements/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
