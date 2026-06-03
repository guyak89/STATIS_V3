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
  subscriptions: number;
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
      `detail:souscriptions-tontine:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

WITH Souscriptions AS (
  SELECT
    COALESCE(NULLIF(LTRIM(RTRIM(ta.CODE_COLLECT_ADHE)), ''), 'SANS_CODE') COLLATE DATABASE_DEFAULT AS collectorCode,
    COALESCE(NULLIF(LTRIM(RTRIM(tc.NOM)), ''), 'Collecteur non identifie') COLLATE DATABASE_DEFAULT AS nom,
    COALESCE(NULLIF(LTRIM(RTRIM(tc.PRENOM)), ''), '') COLLATE DATABASE_DEFAULT AS prenom,
    CAST(COUNT_BIG(*) AS int) AS subscriptions
  FROM T_ADHERENT ta
  LEFT JOIN T_COLLECTEUR tc
    ON tc.CODE_COLLECT COLLATE DATABASE_DEFAULT = ta.CODE_COLLECT_ADHE COLLATE DATABASE_DEFAULT
  WHERE ta.CODE_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND ta.DATE_INSCRIPT_ADHE >= @MonthStart
    AND ta.DATE_INSCRIPT_ADHE <= @AsOfDate
  GROUP BY
    COALESCE(NULLIF(LTRIM(RTRIM(ta.CODE_COLLECT_ADHE)), ''), 'SANS_CODE') COLLATE DATABASE_DEFAULT,
    COALESCE(NULLIF(LTRIM(RTRIM(tc.NOM)), ''), 'Collecteur non identifie') COLLATE DATABASE_DEFAULT,
    COALESCE(NULLIF(LTRIM(RTRIM(tc.PRENOM)), ''), '') COLLATE DATABASE_DEFAULT
)
SELECT
  a.COD_AGENCE AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) AS asOfDate,
  CONVERT(varchar(10), @MonthStart, 23) AS monthStart,
  s.collectorCode,
  s.nom,
  s.prenom,
  ISNULL(s.subscriptions, 0) AS subscriptions,
  CASE WHEN s.collectorCode IS NULL THEN 0 ELSE 1 END AS hasData
FROM AGENCE a
LEFT JOIN Souscriptions s
  ON 1 = 1
WHERE a.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
ORDER BY ISNULL(s.subscriptions, 0) DESC, s.collectorCode;
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
        subscriptions: asNumber(row.subscriptions),
      }));

    const total = rows.reduce((sum, row) => sum + row.subscriptions, 0);

    return NextResponse.json(
      {
        indicator: "souscriptions-tontine",
        label: "Souscriptions Tontine",
        unit: "count",
        agencyCode,
        agencyName: asString(first.agencyName),
        asOfDate: asString(first.asOfDate),
        monthStart: asString(first.monthStart),
        total,
        collectors: rows.length,
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
    console.error(`[detail/souscriptions-tontine/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
