import { NextResponse } from "next/server";
import {
  getPublicAgencySettings,
} from "@/lib/agency-settings";
import {
  addAgencyScopeInputs,
  isAgencyAllowedByScope,
  publicAgencyScope,
  resolveAgencyScope,
} from "@/lib/agency-profiles";
import { CASH_OPERATIONS_CTE } from "@/lib/cash-operations-sql";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";

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
    const agencySettings = {
      ...getPublicAgencySettings(),
      ...publicAgencyScope(scope),
    };
    const forceRefresh = new URL(req.url).searchParams.has("refresh");
    const rows = await sqlCache(
      `detail:operations-caisse:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(addAgencyScopeInputs(pool.request(), scope), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH
${CASH_OPERATIONS_CTE},
CashDeskAgg AS (
  SELECT
    cashDeskKey,
    MAX(cashDeskCode) AS cashDeskCode,
    MAX(cashDeskLabel) AS cashDeskLabel,
    MAX(cashDeskAccount) AS cashDeskAccount,
    SUM(CAST(amount AS MONEY)) AS valeur,
    SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS MONEY)) AS cashInAmount,
    SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)) AS cashOutAmount,
    CAST(COUNT_BIG(*) AS bigint) AS operations
  FROM CashOperations
  WHERE agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
  GROUP BY cashDeskKey
),
CashDeskRefRaw AS (
  SELECT
    ca.KP_CAIS_AGENCE COLLATE DATABASE_DEFAULT AS cashDeskKey,
    ca.COD_CAIS COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(COALESCE(cais.LIB_CAIS, N'Caisse ' + ca.COD_CAIS) AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    ca.NUM_CPTE COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    ca.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(0 AS int) AS syntheticOrder
  FROM CAIS_AGENCE ca WITH (NOLOCK)
  LEFT JOIN CAISSE cais WITH (NOLOCK)
    ON cais.COD_CAIS COLLATE DATABASE_DEFAULT = ca.COD_CAIS COLLATE DATABASE_DEFAULT
  WHERE ca.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT

  UNION ALL

  SELECT
    co.cashDeskKey,
    MAX(co.cashDeskCode) AS cashDeskCode,
    MAX(co.cashDeskLabel) AS cashDeskLabel,
    MAX(co.cashDeskAccount) AS cashDeskAccount,
    co.agencyCode,
    CAST(1 AS int) AS syntheticOrder
  FROM CashOperations co
  WHERE co.agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
  GROUP BY co.cashDeskKey, co.agencyCode
),
CashDeskRef AS (
  SELECT
    cashDeskKey,
    MAX(cashDeskCode) AS cashDeskCode,
    MAX(cashDeskLabel) AS cashDeskLabel,
    MAX(cashDeskAccount) AS cashDeskAccount,
    MAX(agencyCode) AS agencyCode,
    MIN(syntheticOrder) AS syntheticOrder
  FROM CashDeskRefRaw
  GROUP BY cashDeskKey
),
AgencySummary AS (
  SELECT
    ISNULL(SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS MONEY)), 0) AS cashInAmount,
    ISNULL(SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)), 0) AS cashOutAmount,
    ISNULL(SUM(CAST(amount AS MONEY)), 0) AS valeur,
    CAST(COUNT_BIG(*) AS bigint) AS operations
  FROM CashOperations
  WHERE agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
)
SELECT
  CAST('summary' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(0 AS int) AS rowOrder,
  CAST(0 AS int) AS syntheticOrder,
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CAST(NULL AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
  CAST(NULL AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
  CAST(NULL AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
  s.valeur AS valeur,
  s.cashInAmount AS cashInAmount,
  s.cashOutAmount AS cashOutAmount,
  s.operations AS operations
FROM AGENCE a
CROSS JOIN AgencySummary s
WHERE a.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT

UNION ALL

SELECT
  CAST('cashdesk' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(1 AS int) AS rowOrder,
  ref.syntheticOrder,
  ref.agencyCode,
  CAST(NULL AS varchar(160)) COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  ref.cashDeskKey,
  ref.cashDeskCode,
  ref.cashDeskLabel,
  ref.cashDeskAccount,
  ISNULL(agg.valeur, 0) AS valeur,
  ISNULL(agg.cashInAmount, 0) AS cashInAmount,
  ISNULL(agg.cashOutAmount, 0) AS cashOutAmount,
  ISNULL(agg.operations, 0) AS operations
FROM CashDeskRef ref
LEFT JOIN CashDeskAgg agg
  ON agg.cashDeskKey COLLATE DATABASE_DEFAULT = ref.cashDeskKey COLLATE DATABASE_DEFAULT
ORDER BY rowOrder, syntheticOrder, valeur DESC, cashDeskCode;
`);

    return (result.recordset ?? []) as SqlRow[];
      },
      undefined,
      { forceRefresh },
    );
    const summary = rows.find((row) => asString(row.rowType) === "summary");

    if (!summary) {
      return NextResponse.json(
        { error: `Agence inconnue : "${agencyCode}"` },
        { status: 404 },
      );
    }

    const cashDeskRows = rows
      .filter((row) => asString(row.rowType) === "cashdesk")
      .map((row) => ({
        cashDeskKey: asString(row.cashDeskKey),
        cashDeskCode: asString(row.cashDeskCode),
        cashDeskLabel: asString(row.cashDeskLabel),
        cashDeskAccount: asString(row.cashDeskAccount),
        valeur: asNumber(row.valeur),
        cashInAmount: asNumber(row.cashInAmount),
        cashOutAmount: asNumber(row.cashOutAmount),
        operations: asNumber(row.operations),
      }));

    return NextResponse.json(
      {
        indicator: "operations-caisse",
        label: "Opérations de caisse",
        unit: "currency",
        level: "cashdesk",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        total: asNumber(summary.valeur),
        cashInAmount: asNumber(summary.cashInAmount),
        cashOutAmount: asNumber(summary.cashOutAmount),
        operations: asNumber(summary.operations),
        rows: cashDeskRows,
        agencySettings,
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
    console.error(`[detail/operations-caisse/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
