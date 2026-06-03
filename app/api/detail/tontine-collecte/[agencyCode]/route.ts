import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

type CollectorRow = {
  collectorCode: string;
  nom: string;
  prenom: string;
  operations: number;
  depotCount: number;
  commissionCount: number;
  annulationCount: number;
  depotAmount: number;
  commissionAmount: number;
  annulationAmount: number;
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
    const recordset = await sqlCache(
      `detail:tontine-collecte:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

WITH Collecte AS (
  SELECT
    c.COD_AGENCE AS agencyCode,
    COALESCE(NULLIF(LTRIM(RTRIM(op.CODE_COLLECT)), ''), 'SANS_CODE') AS collectorCode,
    COALESCE(NULLIF(LTRIM(RTRIM(tc.NOM)), ''), 'Collecteur non identifie') AS nom,
    COALESCE(NULLIF(LTRIM(RTRIM(tc.PRENOM)), ''), '') AS prenom,
    CAST(COUNT_BIG(op.ID_OP) AS int) AS operations,
    CAST(SUM(CASE WHEN op.TYPE_OP = 'D' THEN 1 ELSE 0 END) AS int) AS depotCount,
    CAST(SUM(CASE WHEN op.TYPE_OP = 'C' THEN 1 ELSE 0 END) AS int) AS commissionCount,
    CAST(SUM(CASE WHEN op.TYPE_OP = 'A' THEN 1 ELSE 0 END) AS int) AS annulationCount,
    SUM(CAST(CASE WHEN op.TYPE_OP = 'D' THEN ISNULL(op.MONTANT_OP, 0) ELSE 0 END AS MONEY)) AS depotAmount,
    SUM(CAST(CASE WHEN op.TYPE_OP = 'C' THEN ISNULL(op.MONTANT_OP, 0) ELSE 0 END AS MONEY)) AS commissionAmount,
    SUM(CAST(CASE WHEN op.TYPE_OP = 'A' THEN ISNULL(op.MONTANT_OP, 0) ELSE 0 END AS MONEY)) AS annulationAmount,
    SUM(CAST(CASE WHEN op.TYPE_OP = 'A' THEN -ISNULL(op.MONTANT_OP, 0) ELSE ISNULL(op.MONTANT_OP, 0) END AS MONEY)) AS valeur
  FROM T_OPERATION op
  JOIN COMPTES c
    ON c.NUM_CPTE COLLATE DATABASE_DEFAULT = op.NUM_CMPTE COLLATE DATABASE_DEFAULT
  LEFT JOIN T_COLLECTEUR tc
    ON tc.CODE_COLLECT COLLATE DATABASE_DEFAULT = op.CODE_COLLECT COLLATE DATABASE_DEFAULT
  WHERE c.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND op.TYPE_OP IN ('D', 'C', 'A')
    AND op.DATE_VALIDATION >= @MonthStart
    AND op.DATE_VALIDATION < DATEADD(DAY, 1, @AsOfDate)
  GROUP BY
    c.COD_AGENCE,
    COALESCE(NULLIF(LTRIM(RTRIM(op.CODE_COLLECT)), ''), 'SANS_CODE'),
    COALESCE(NULLIF(LTRIM(RTRIM(tc.NOM)), ''), 'Collecteur non identifie'),
    COALESCE(NULLIF(LTRIM(RTRIM(tc.PRENOM)), ''), '')
)
SELECT
  a.COD_AGENCE AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) AS asOfDate,
  CONVERT(varchar(10), @MonthStart, 23) AS monthStart,
  co.collectorCode,
  co.nom,
  co.prenom,
  ISNULL(co.operations, 0) AS operations,
  ISNULL(co.depotCount, 0) AS depotCount,
  ISNULL(co.commissionCount, 0) AS commissionCount,
  ISNULL(co.annulationCount, 0) AS annulationCount,
  ISNULL(co.depotAmount, 0) AS depotAmount,
  ISNULL(co.commissionAmount, 0) AS commissionAmount,
  ISNULL(co.annulationAmount, 0) AS annulationAmount,
  ISNULL(co.valeur, 0) AS valeur,
  CASE WHEN co.collectorCode IS NULL THEN 0 ELSE 1 END AS hasData
FROM AGENCE a
LEFT JOIN Collecte co
  ON co.agencyCode = a.COD_AGENCE
WHERE a.COD_AGENCE = @AgencyCode
ORDER BY ISNULL(co.valeur, 0) DESC, co.collectorCode;
`);

    return (result.recordset ?? []) as SqlRow[];
      },
      undefined,
      { forceRefresh },
    );

    if (recordset.length === 0) {
      return NextResponse.json(
        { error: `Agence inconnue : "${agencyCode}"` },
        { status: 404 },
      );
    }

    const first = recordset[0];
    const rows: CollectorRow[] = recordset
      .filter((row) => asNumber(row.hasData) === 1)
      .map((row) => ({
        collectorCode: asString(row.collectorCode),
        nom: asString(row.nom),
        prenom: asString(row.prenom),
        operations: asNumber(row.operations),
        depotCount: asNumber(row.depotCount),
        commissionCount: asNumber(row.commissionCount),
        annulationCount: asNumber(row.annulationCount),
        depotAmount: asNumber(row.depotAmount),
        commissionAmount: asNumber(row.commissionAmount),
        annulationAmount: asNumber(row.annulationAmount),
        valeur: asNumber(row.valeur),
      }));

    const total = rows.reduce((sum, row) => sum + row.valeur, 0);
    const operations = rows.reduce((sum, row) => sum + row.operations, 0);

    return NextResponse.json(
      {
        indicator: "tontine-collecte",
        label: "Volume Collecte Tontine",
        unit: "currency",
        agencyCode,
        agencyName: asString(first.agencyName),
        asOfDate: asString(first.asOfDate),
        monthStart: asString(first.monthStart),
        total,
        operations,
        rows,
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
    console.error(`[detail/tontine-collecte/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
