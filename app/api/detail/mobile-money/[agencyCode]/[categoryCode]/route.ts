import { NextResponse } from "next/server";
import {
  getPublicAgencySettings,
} from "@/lib/agency-settings";
import { isAgencyAllowedByScope, publicAgencyScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";
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

function normalizeCategoryCode(value: string): string {
  return decodeURIComponent(value).trim();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agencyCode: string; categoryCode: string }> },
) {
  const { agencyCode: rawAgencyCode, categoryCode: rawCategoryCode } = await params;
  const agencyCode = normalizeAgencyCode(rawAgencyCode ?? "");
  const categoryCode = normalizeCategoryCode(rawCategoryCode ?? "");

  if (!/^[A-Z0-9]{3}$/.test(agencyCode)) {
    return NextResponse.json({ error: `Code agence invalide : "${agencyCode}"` }, { status: 400 });
  }

  if (!/^(wallet-to-bank|bank-to-wallet)$/.test(categoryCode)) {
    return NextResponse.json({ error: `Rubrique Mobile Money invalide : "${categoryCode}"` }, { status: 400 });
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
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .input("CategoryCode", categoryCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH
${MOBILE_MONEY_CTE},
FilteredOperations AS (
  SELECT *
  FROM MobileMoneyOperations
  WHERE agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND mobileMoneyType COLLATE DATABASE_DEFAULT = @CategoryCode COLLATE DATABASE_DEFAULT
),
Summary AS (
  SELECT
    ISNULL(SUM(CAST(amount AS money)), 0) AS valeur,
    ISNULL(SUM(CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS money)), 0) AS depositAmount,
    ISNULL(SUM(CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS money)), 0) AS withdrawalAmount,
    CAST(COUNT_BIG(*) AS bigint) AS operations,
    MAX(mobileMoneyLabel) AS categoryLabel,
    MAX(direction) AS direction
  FROM FilteredOperations
)
SELECT
  CAST('summary' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CAST(@CategoryCode AS varchar(30)) COLLATE DATABASE_DEFAULT AS categoryCode,
  COALESCE(s.categoryLabel, CASE WHEN @CategoryCode = 'wallet-to-bank' THEN N'Depots Wallet to Bank' ELSE N'Retraits Bank to Wallet' END) COLLATE DATABASE_DEFAULT AS categoryLabel,
  COALESCE(s.direction, CASE WHEN @CategoryCode = 'wallet-to-bank' THEN 'IN' ELSE 'OUT' END) COLLATE DATABASE_DEFAULT AS direction,
  s.valeur,
  s.depositAmount,
  s.withdrawalAmount,
  s.operations,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
  CAST(NULL AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
  CAST(NULL AS datetime) AS operationDate,
  CAST(NULL AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
  CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
  CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
  CAST(NULL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
  CAST(NULL AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
  CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
  CAST(NULL AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode,
  CAST(NULL AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode
FROM AGENCE a
CROSS JOIN Summary s
WHERE a.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT

UNION ALL

SELECT
  CAST('operation' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  agencyCode,
  CAST(NULL AS varchar(160)) COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  mobileMoneyType AS categoryCode,
  mobileMoneyLabel AS categoryLabel,
  direction,
  amount AS valeur,
  CAST(CASE WHEN direction = 'IN' THEN amount ELSE 0 END AS money) AS depositAmount,
  CAST(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END AS money) AS withdrawalAmount,
  CAST(1 AS bigint) AS operations,
  operationId,
  operationNumber,
  receiptNumber,
  operationCode,
  operationDate,
  accountNumber,
  accountLabel,
  customerName,
  userCode,
  description,
  chequeNumber,
  currencyCode,
  cashDeskKey,
  cashDeskCode
FROM FilteredOperations
ORDER BY rowType DESC, operationDate DESC, operationNumber DESC;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const summary = rows.find((row) => asString(row.rowType) === "summary");

    if (!summary) {
      return NextResponse.json({ error: `Agence inconnue : "${agencyCode}"` }, { status: 404 });
    }

    const operationRows = rows
      .filter((row) => asString(row.rowType) === "operation")
      .map((row) => ({
        operationId: asString(row.operationId),
        operationNumber: asString(row.operationNumber),
        receiptNumber: asString(row.receiptNumber),
        operationCode: asString(row.operationCode),
        operationDate: asString(row.operationDate),
        accountNumber: asString(row.accountNumber),
        accountLabel: asString(row.accountLabel),
        customerName: asString(row.customerName),
        userCode: asString(row.userCode),
        description: asString(row.description),
        chequeNumber: asString(row.chequeNumber),
        currencyCode: asString(row.currencyCode),
        cashDeskKey: asString(row.cashDeskKey),
        cashDeskCode: asString(row.cashDeskCode),
        amount: asNumber(row.valeur),
        direction: asString(row.direction),
      }));

    return NextResponse.json({
      indicator: "mobile-money",
      label: "Mobile Money",
      unit: "currency",
      level: "operations",
      agencyCode,
      agencyName: asString(summary.agencyName),
      asOfDate: asString(summary.asOfDate),
      categoryCode,
      categoryLabel: asString(summary.categoryLabel),
      direction: asString(summary.direction),
      total: asNumber(summary.valeur),
      depositAmount: asNumber(summary.depositAmount),
      withdrawalAmount: asNumber(summary.withdrawalAmount),
      operations: asNumber(summary.operations),
      rows: operationRows,
      agencySettings,
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    console.error(`[detail/mobile-money/${agencyCode}/${categoryCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
