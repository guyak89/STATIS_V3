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

function normalizePathPart(value: string): string {
  return decodeURIComponent(value).trim();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agencyCode: string; cashDeskKey: string; categoryCode: string }> },
) {
  const {
    agencyCode: rawAgencyCode,
    cashDeskKey: rawCashDeskKey,
    categoryCode: rawCategoryCode,
  } = await params;
  const agencyCode = normalizeAgencyCode(rawAgencyCode ?? "");
  const cashDeskKey = normalizePathPart(rawCashDeskKey ?? "");
  const categoryCode = normalizePathPart(rawCategoryCode ?? "");

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

  if (!/^[a-z0-9-]{1,60}$/.test(categoryCode)) {
    return NextResponse.json(
      { error: `Type d'opération invalide : "${categoryCode}"` },
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
      .input("CategoryCode", categoryCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH
${CASH_CATEGORIES_CTE},
${CASH_OPERATIONS_CTE},
FilteredOperations AS (
  SELECT *
  FROM CashOperations
  WHERE agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND cashDeskKey COLLATE DATABASE_DEFAULT = @CashDeskKey COLLATE DATABASE_DEFAULT
    AND categoryCode COLLATE DATABASE_DEFAULT = @CategoryCode COLLATE DATABASE_DEFAULT
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
),
CategoryRef AS (
  SELECT categoryCode, categoryLabel, direction
  FROM CashCategories
  WHERE categoryCode COLLATE DATABASE_DEFAULT = @CategoryCode COLLATE DATABASE_DEFAULT
),
Summary AS (
  SELECT
    ref.cashDeskCode,
    ref.cashDeskLabel,
    ref.cashDeskAccount,
    cr.categoryLabel,
    cr.direction,
    ISNULL(SUM(CAST(fo.amount AS MONEY)), 0) AS valeur,
    ISNULL(SUM(CAST(CASE WHEN fo.direction = 'IN' THEN fo.amount ELSE 0 END AS MONEY)), 0) AS cashInAmount,
    ISNULL(SUM(CAST(CASE WHEN fo.direction = 'OUT' THEN fo.amount ELSE 0 END AS MONEY)), 0) AS cashOutAmount,
    CAST(COUNT_BIG(fo.operationId) AS bigint) AS operations
  FROM CashDeskRef ref
  CROSS JOIN CategoryRef cr
  LEFT JOIN FilteredOperations fo
    ON fo.cashDeskKey COLLATE DATABASE_DEFAULT = ref.cashDeskKey COLLATE DATABASE_DEFAULT
  GROUP BY ref.cashDeskCode, ref.cashDeskLabel, ref.cashDeskAccount, cr.categoryLabel, cr.direction
)
SELECT
  CAST('summary' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CAST(@CashDeskKey AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
  s.cashDeskCode,
  s.cashDeskLabel,
  s.cashDeskAccount,
  CAST(@CategoryCode AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
  s.categoryLabel,
  s.direction,
  s.valeur,
  s.cashInAmount,
  s.cashOutAmount,
  s.operations,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationSource,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
  CAST(NULL AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
  CAST(NULL AS nvarchar(160)) COLLATE DATABASE_DEFAULT AS operationLabel,
  CAST(NULL AS datetime) AS operationDate,
  CAST(NULL AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
  CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS customerCode,
  CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
  CAST(NULL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS collectorCode,
  CAST(NULL AS nvarchar(140)) COLLATE DATABASE_DEFAULT AS collectorName,
  CAST(NULL AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
  CAST(NULL AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode
FROM AGENCE a
CROSS JOIN Summary s
WHERE a.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT

UNION ALL

SELECT
  CAST('operation' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  agencyCode,
  CAST(NULL AS varchar(160)) COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  cashDeskKey,
  cashDeskCode,
  cashDeskLabel,
  cashDeskAccount,
  categoryCode,
  categoryLabel,
  direction,
  amount AS valeur,
  CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS MONEY) AS cashInAmount,
  CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS MONEY) AS cashOutAmount,
  CAST(1 AS bigint) AS operations,
  operationSource,
  operationId,
  operationNumber,
  receiptNumber,
  operationCode,
  operationLabel,
  operationDate,
  accountNumber,
  accountLabel,
  customerCode,
  customerName,
  userCode,
  collectorCode,
  collectorName,
  description,
  chequeNumber,
  currencyCode
FROM FilteredOperations
ORDER BY rowType DESC, operationDate DESC, operationNumber DESC;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const summary = rows.find((row) => asString(row.rowType) === "summary");

    if (!summary) {
      return NextResponse.json(
        { error: `Type d'opération inconnu : "${categoryCode}"` },
        { status: 404 },
      );
    }

    const operationRows = rows
      .filter((row) => asString(row.rowType) === "operation")
      .map((row) => ({
        operationSource: asString(row.operationSource),
        operationId: asString(row.operationId),
        operationNumber: asString(row.operationNumber),
        receiptNumber: asString(row.receiptNumber),
        operationCode: asString(row.operationCode),
        operationLabel: asString(row.operationLabel),
        operationDate: asString(row.operationDate),
        accountNumber: asString(row.accountNumber),
        accountLabel: asString(row.accountLabel),
        customerCode: asString(row.customerCode),
        customerName: asString(row.customerName),
        userCode: asString(row.userCode),
        collectorCode: asString(row.collectorCode),
        collectorName: asString(row.collectorName),
        description: asString(row.description),
        chequeNumber: asString(row.chequeNumber),
        currencyCode: asString(row.currencyCode),
        amount: asNumber(row.valeur),
        direction: asString(row.direction) as "IN" | "OUT",
      }));

    return NextResponse.json(
      {
        indicator: "operations-caisse",
        label: "Opérations de caisse",
        unit: "currency",
        level: "operations",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        cashDeskKey,
        cashDeskCode: asString(summary.cashDeskCode),
        cashDeskLabel: asString(summary.cashDeskLabel),
        cashDeskAccount: asString(summary.cashDeskAccount),
        categoryCode,
        categoryLabel: asString(summary.categoryLabel),
        direction: asString(summary.direction) as "IN" | "OUT",
        total: asNumber(summary.valeur),
        cashInAmount: asNumber(summary.cashInAmount),
        cashOutAmount: asNumber(summary.cashOutAmount),
        operations: asNumber(summary.operations),
        rows: operationRows,
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
    console.error(`[detail/operations-caisse/${agencyCode}/${cashDeskKey}/${categoryCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
