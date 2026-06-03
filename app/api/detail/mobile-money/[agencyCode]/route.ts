import { NextResponse } from "next/server";
import {
  getPublicAgencySettings,
} from "@/lib/agency-settings";
import { isAgencyAllowedByScope, publicAgencyScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";
import { getPool } from "@/lib/db";
import { MOBILE_MONEY_CTE } from "@/lib/mobile-money-sql";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function asString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
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
    return NextResponse.json({ error: `Code agence invalide : "${agencyCode}"` }, { status: 400 });
  }

  const scope = resolveAgencyScope(req);
  if (!isAgencyAllowedByScope(agencyCode, scope)) {
    return NextResponse.json({ error: `Agence faitiere exclue par parametrage : "${agencyCode}"` }, { status: 403 });
  }

  try {
    const requestedAsOfDate = parseAsOfDateParam(req);
    const agencySettings = {
      ...getPublicAgencySettings(),
      ...publicAgencyScope(scope),
    };
    const forceRefresh = new URL(req.url).searchParams.has("refresh");
    const rows = await sqlCache(
      `detail:mobile-money:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH
${MOBILE_MONEY_CTE},
FilteredMobileMoney AS (
  SELECT *
  FROM MobileMoneyOperations
  WHERE agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
),
CategoryAgg AS (
  SELECT
    mobileMoneyType,
    MAX(mobileMoneyLabel) AS mobileMoneyLabel,
    MAX(direction) AS direction,
    SUM(CAST(amount AS money)) AS valeur,
    CAST(COUNT_BIG(*) AS bigint) AS operations
  FROM FilteredMobileMoney
  GROUP BY mobileMoneyType
),
Summary AS (
  SELECT
    ISNULL(SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS money)), 0) AS depositAmount,
    ISNULL(SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS money)), 0) AS withdrawalAmount,
    ISNULL(SUM(CAST(amount AS money)), 0) AS valeur,
    CAST(COUNT_BIG(*) AS bigint) AS operations
  FROM FilteredMobileMoney
)
SELECT
  CAST('summary' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(0 AS int) AS rowOrder,
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CAST(NULL AS varchar(30)) COLLATE DATABASE_DEFAULT AS categoryCode,
  CAST(NULL AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
  CAST(NULL AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
  s.valeur,
  s.depositAmount,
  s.withdrawalAmount,
  s.operations
FROM AGENCE a
CROSS JOIN Summary s
WHERE a.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT

UNION ALL

SELECT
  CAST('category' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CASE WHEN v.categoryCode = 'wallet-to-bank' THEN 1 ELSE 2 END AS rowOrder,
  CAST(@AgencyCode AS varchar(3)) COLLATE DATABASE_DEFAULT AS agencyCode,
  CAST(NULL AS varchar(160)) COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  v.categoryCode COLLATE DATABASE_DEFAULT AS categoryCode,
  v.categoryLabel COLLATE DATABASE_DEFAULT AS categoryLabel,
  v.direction COLLATE DATABASE_DEFAULT AS direction,
  ISNULL(ca.valeur, 0) AS valeur,
  CAST(CASE WHEN v.direction = 'IN' THEN ISNULL(ca.valeur, 0) ELSE 0 END AS money) AS depositAmount,
  CAST(CASE WHEN v.direction = 'OUT' THEN ISNULL(ca.valeur, 0) ELSE 0 END AS money) AS withdrawalAmount,
  ISNULL(ca.operations, 0) AS operations
FROM (VALUES
  ('wallet-to-bank', N'Depots Wallet to Bank', 'IN'),
  ('bank-to-wallet', N'Retraits Bank to Wallet', 'OUT')
) AS v(categoryCode, categoryLabel, direction)
LEFT JOIN CategoryAgg ca
  ON ca.mobileMoneyType COLLATE DATABASE_DEFAULT = v.categoryCode COLLATE DATABASE_DEFAULT
ORDER BY rowOrder;
`);

    return (result.recordset ?? []) as SqlRow[];
      },
      undefined,
      { forceRefresh },
    );
    const summary = rows.find((row) => asString(row.rowType) === "summary");

    if (!summary) {
      return NextResponse.json({ error: `Agence inconnue : "${agencyCode}"` }, { status: 404 });
    }

    const categoryRows = rows
      .filter((row) => asString(row.rowType) === "category")
      .map((row) => ({
        categoryCode: asString(row.categoryCode),
        categoryLabel: asString(row.categoryLabel),
        direction: asString(row.direction),
        valeur: asNumber(row.valeur),
        depositAmount: asNumber(row.depositAmount),
        withdrawalAmount: asNumber(row.withdrawalAmount),
        operations: asNumber(row.operations),
      }));

    return NextResponse.json({
      indicator: "mobile-money",
      label: "Mobile Money",
      unit: "currency",
      level: "category",
      agencyCode,
      agencyName: asString(summary.agencyName),
      asOfDate: asString(summary.asOfDate),
      total: asNumber(summary.valeur),
      depositAmount: asNumber(summary.depositAmount),
      withdrawalAmount: asNumber(summary.withdrawalAmount),
      operations: asNumber(summary.operations),
      rows: categoryRows,
      agencySettings,
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    console.error(`[detail/mobile-money/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
