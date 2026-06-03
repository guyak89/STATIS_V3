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
import {
  CASH_CATEGORIES_CTE,
  CASH_OPERATIONS_CTE,
} from "@/lib/cash-operations-sql";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";

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

function normalizeCashDeskKey(value: string): string {
  return decodeURIComponent(value).trim();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agencyCode: string; cashDeskKey: string }> },
) {
  const { agencyCode: rawAgencyCode, cashDeskKey: rawCashDeskKey } = await params;
  const agencyCode = normalizeAgencyCode(rawAgencyCode ?? "");
  const cashDeskKey = normalizeCashDeskKey(rawCashDeskKey ?? "");

  if (!/^[A-Z0-9]{3}$/.test(agencyCode)) {
    return NextResponse.json(
      { error: `Code agence invalide : "${agencyCode}"` },
      { status: 400 },
    );
  }

  if (!/^[A-Za-z0-9:._-]{1,60}$/.test(cashDeskKey)) {
    return NextResponse.json(
      { error: `Code caisse invalide : "${cashDeskKey}"` },
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
    const pool = await getPool();
    const result = await addAsOfDateInput(addAgencyScopeInputs(pool.request(), scope), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .input("CashDeskKey", cashDeskKey)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH
${CASH_CATEGORIES_CTE},
${CASH_OPERATIONS_CTE},
CategoryAgg AS (
  SELECT
    categoryCode,
    SUM(CAST(amount AS MONEY)) AS valeur,
    SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS MONEY)) AS cashInAmount,
    SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)) AS cashOutAmount,
    CAST(COUNT_BIG(*) AS bigint) AS operations
  FROM CashOperations
  WHERE agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND cashDeskKey COLLATE DATABASE_DEFAULT = @CashDeskKey COLLATE DATABASE_DEFAULT
  GROUP BY categoryCode
),
CashDeskBalance AS (
  SELECT
    ISNULL(MAX(CAST(dc.SOLDE_VEILLE AS MONEY)), 0) AS previousBalance
  FROM JOURNEE j WITH (NOLOCK)
  LEFT JOIN DETAIL_CAIS dc WITH (NOLOCK)
    ON dc.KP_JOURNEE COLLATE DATABASE_DEFAULT = j.KP_JOURNEE COLLATE DATABASE_DEFAULT
   AND dc.KP_CAIS_AGENCE COLLATE DATABASE_DEFAULT = @CashDeskKey COLLATE DATABASE_DEFAULT
  WHERE CAST(j.DATE_JOUR AS date) = @AsOfDate
    AND j.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
),
CashDeskSummary AS (
  SELECT
    MAX(cashDeskCode) AS cashDeskCode,
    MAX(cashDeskLabel) AS cashDeskLabel,
    MAX(cashDeskAccount) AS cashDeskAccount,
    ISNULL(SUM(CAST(amount AS MONEY)), 0) AS valeur,
    ISNULL(SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS MONEY)), 0) AS cashInAmount,
    ISNULL(SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY)), 0) AS cashOutAmount,
    CAST(COUNT_BIG(*) AS bigint) AS operations
  FROM CashOperations
  WHERE agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND cashDeskKey COLLATE DATABASE_DEFAULT = @CashDeskKey COLLATE DATABASE_DEFAULT
),
CashDeskRef AS (
  SELECT
    ca.KP_CAIS_AGENCE COLLATE DATABASE_DEFAULT AS cashDeskKey,
    ca.COD_CAIS COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(COALESCE(cais.LIB_CAIS, N'Caisse ' + ca.COD_CAIS) AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    ca.NUM_CPTE COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    ca.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode
  FROM CAIS_AGENCE ca WITH (NOLOCK)
  LEFT JOIN CAISSE cais WITH (NOLOCK)
    ON cais.COD_CAIS COLLATE DATABASE_DEFAULT = ca.COD_CAIS COLLATE DATABASE_DEFAULT
  WHERE ca.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND ca.KP_CAIS_AGENCE COLLATE DATABASE_DEFAULT = @CashDeskKey COLLATE DATABASE_DEFAULT

  UNION

  SELECT
    co.cashDeskKey,
    MAX(co.cashDeskCode) AS cashDeskCode,
    MAX(co.cashDeskLabel) AS cashDeskLabel,
    MAX(co.cashDeskAccount) AS cashDeskAccount,
    co.agencyCode
  FROM CashOperations co
  WHERE co.agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND co.cashDeskKey COLLATE DATABASE_DEFAULT = @CashDeskKey COLLATE DATABASE_DEFAULT
  GROUP BY co.cashDeskKey, co.agencyCode
)
SELECT
  CAST('summary' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(0 AS int) AS rowOrder,
  CAST(0 AS int) AS sortOrder,
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  ref.cashDeskKey,
  COALESCE(s.cashDeskCode, ref.cashDeskCode) AS cashDeskCode,
  COALESCE(s.cashDeskLabel, ref.cashDeskLabel) AS cashDeskLabel,
  COALESCE(s.cashDeskAccount, ref.cashDeskAccount) AS cashDeskAccount,
  CAST(NULL AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
  CAST(NULL AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
  CAST(NULL AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
  ISNULL(s.valeur, 0) AS valeur,
  ISNULL(s.cashInAmount, 0) AS cashInAmount,
  ISNULL(s.cashOutAmount, 0) AS cashOutAmount,
  ISNULL(b.previousBalance, 0) AS previousBalance,
  ISNULL(b.previousBalance, 0) + ISNULL(s.cashInAmount, 0) - ISNULL(s.cashOutAmount, 0) AS calculatedBalance,
  ISNULL(s.operations, 0) AS operations
FROM CashDeskRef ref
JOIN AGENCE a
  ON a.COD_AGENCE COLLATE DATABASE_DEFAULT = ref.agencyCode COLLATE DATABASE_DEFAULT
CROSS JOIN CashDeskSummary s
CROSS JOIN CashDeskBalance b

UNION ALL

SELECT
  CAST('category' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(1 AS int) AS rowOrder,
  cc.sortOrder,
  CAST(@AgencyCode AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
  CAST(NULL AS varchar(160)) COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CAST(@CashDeskKey AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
  CAST(NULL AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
  CAST(NULL AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
  cc.categoryCode COLLATE DATABASE_DEFAULT AS categoryCode,
  cc.categoryLabel COLLATE DATABASE_DEFAULT AS categoryLabel,
  cc.direction COLLATE DATABASE_DEFAULT AS direction,
  ISNULL(ca.valeur, 0) AS valeur,
  ISNULL(ca.cashInAmount, 0) AS cashInAmount,
  ISNULL(ca.cashOutAmount, 0) AS cashOutAmount,
  CAST(0 AS MONEY) AS previousBalance,
  CAST(0 AS MONEY) AS calculatedBalance,
  ISNULL(ca.operations, 0) AS operations
FROM CashCategories cc
LEFT JOIN CategoryAgg ca
  ON ca.categoryCode COLLATE DATABASE_DEFAULT = cc.categoryCode COLLATE DATABASE_DEFAULT
ORDER BY rowOrder, sortOrder, valeur DESC;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const summary = rows.find((row) => asString(row.rowType) === "summary");

    if (!summary) {
      return NextResponse.json(
        { error: `Caisse inconnue : "${cashDeskKey}" pour l'agence "${agencyCode}"` },
        { status: 404 },
      );
    }

    const categoryRows = rows
      .filter((row) => asString(row.rowType) === "category")
      .map((row) => ({
        categoryCode: asString(row.categoryCode),
        categoryLabel: asString(row.categoryLabel),
        direction: asString(row.direction) as "IN" | "OUT",
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
        level: "category",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        cashDeskKey,
        cashDeskCode: asString(summary.cashDeskCode),
        cashDeskLabel: asString(summary.cashDeskLabel),
        cashDeskAccount: asString(summary.cashDeskAccount),
        total: asNumber(summary.valeur),
        cashInAmount: asNumber(summary.cashInAmount),
        cashOutAmount: asNumber(summary.cashOutAmount),
        previousBalance: asNumber(summary.previousBalance),
        calculatedBalance: asNumber(summary.calculatedBalance),
        operations: asNumber(summary.operations),
        rows: categoryRows,
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
    console.error(`[detail/operations-caisse/${agencyCode}/${cashDeskKey}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
