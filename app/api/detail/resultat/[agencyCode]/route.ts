import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

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
    const rows = await sqlCache(
      `detail:resultat:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", agencyCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @ExerciseStart date = DATEFROMPARTS(YEAR(@AsOfDate), 1, 1);

WITH AccountBalances AS (
  SELECT
    c.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    CASE WHEN c.NUM_CPTE LIKE '7%' THEN 'products' ELSE 'expenses' END AS sectionCode,
    CASE WHEN c.NUM_CPTE LIKE '7%' THEN N'Produits' ELSE N'Charges' END COLLATE DATABASE_DEFAULT AS sectionLabel,
    c.CPTE_GAL COLLATE DATABASE_DEFAULT AS generalAccountNumber,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.LIB_CPTE_GAL)), ''), c.CPTE_GAL) COLLATE DATABASE_DEFAULT AS generalAccountLabel,
    c.NUM_CPTE COLLATE DATABASE_DEFAULT AS accountNumber,
    COALESCE(NULLIF(LTRIM(RTRIM(c.INTITULE_CPTE)), ''), c.NUM_CPTE) COLLATE DATABASE_DEFAULT AS accountLabel,
    SUM(CAST(CASE
      WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0)
      WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS, 0)
      ELSE 0
    END AS money)) AS balance,
    COUNT_BIG(*) AS operations
  FROM HDPM h
  JOIN COMPTES c
    ON c.NUM_CPTE COLLATE DATABASE_DEFAULT = h.NUM_CPTE COLLATE DATABASE_DEFAULT
  LEFT JOIN PLANCPTE pc
    ON pc.CPTE_GAL COLLATE DATABASE_DEFAULT = c.CPTE_GAL COLLATE DATABASE_DEFAULT
  WHERE c.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND h.DATE_OPERATION >= @ExerciseStart
    AND h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
    AND (h.NUM_CPTE LIKE '7%' OR h.NUM_CPTE LIKE '6%')
  GROUP BY
    c.COD_AGENCE,
    CASE WHEN c.NUM_CPTE LIKE '7%' THEN 'products' ELSE 'expenses' END,
    CASE WHEN c.NUM_CPTE LIKE '7%' THEN N'Produits' ELSE N'Charges' END,
    c.CPTE_GAL,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.LIB_CPTE_GAL)), ''), c.CPTE_GAL),
    c.NUM_CPTE,
    COALESCE(NULLIF(LTRIM(RTRIM(c.INTITULE_CPTE)), ''), c.NUM_CPTE)
),
GeneralRows AS (
  SELECT
    sectionCode,
    sectionLabel,
    generalAccountNumber,
    generalAccountLabel,
    SUM(balance) AS generalBalance,
    SUM(operations) AS generalOperations,
    COUNT_BIG(*) AS accountCount
  FROM AccountBalances
  GROUP BY sectionCode, sectionLabel, generalAccountNumber, generalAccountLabel
),
SummaryRow AS (
  SELECT
    a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    CONVERT(varchar(10), @ExerciseStart, 23) COLLATE DATABASE_DEFAULT AS exerciseStart,
    ISNULL(SUM(CASE WHEN ab.sectionCode = 'products' THEN ab.balance ELSE 0 END), 0) AS productsTotal,
    ISNULL(SUM(CASE WHEN ab.sectionCode = 'expenses' THEN ab.balance ELSE 0 END), 0) AS expensesTotal,
    ISNULL(SUM(ab.balance), 0) AS resultTotal,
    CAST(ISNULL(COUNT_BIG(ab.accountNumber), 0) AS int) AS accountCount,
    CAST(ISNULL(SUM(ab.operations), 0) AS bigint) AS operations
  FROM AGENCE a
  LEFT JOIN AccountBalances ab
    ON ab.agencyCode = a.COD_AGENCE COLLATE DATABASE_DEFAULT
  WHERE a.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
  GROUP BY a.COD_AGENCE, a.RAISON_SOCIAL
)
SELECT
  CAST('summary' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(0 AS int) AS rowOrder,
  sr.agencyCode,
  sr.agencyName,
  sr.asOfDate,
  sr.exerciseStart,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS sectionCode,
  CAST(NULL AS nvarchar(40)) COLLATE DATABASE_DEFAULT AS sectionLabel,
  CAST(NULL AS varchar(30)) COLLATE DATABASE_DEFAULT AS generalAccountNumber,
  CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS generalAccountLabel,
  CAST(NULL AS varchar(30)) COLLATE DATABASE_DEFAULT AS accountNumber,
  CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
  sr.productsTotal,
  sr.expensesTotal,
  sr.resultTotal AS balance,
  sr.accountCount,
  sr.operations
FROM SummaryRow sr

UNION ALL

SELECT
  CAST('general' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(1 AS int) AS rowOrder,
  CAST(@AgencyCode AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
  CAST(NULL AS varchar(120)) COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CONVERT(varchar(10), @ExerciseStart, 23) COLLATE DATABASE_DEFAULT AS exerciseStart,
  gr.sectionCode,
  gr.sectionLabel,
  gr.generalAccountNumber,
  gr.generalAccountLabel,
  CAST(NULL AS varchar(30)) COLLATE DATABASE_DEFAULT AS accountNumber,
  CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
  CAST(NULL AS money) AS productsTotal,
  CAST(NULL AS money) AS expensesTotal,
  gr.generalBalance AS balance,
  CAST(gr.accountCount AS int) AS accountCount,
  CAST(gr.generalOperations AS bigint) AS operations
FROM GeneralRows gr

UNION ALL

SELECT
  CAST('account' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  CAST(2 AS int) AS rowOrder,
  ab.agencyCode,
  CAST(NULL AS varchar(120)) COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CONVERT(varchar(10), @ExerciseStart, 23) COLLATE DATABASE_DEFAULT AS exerciseStart,
  ab.sectionCode,
  ab.sectionLabel,
  ab.generalAccountNumber,
  ab.generalAccountLabel,
  ab.accountNumber,
  ab.accountLabel,
  CAST(NULL AS money) AS productsTotal,
  CAST(NULL AS money) AS expensesTotal,
  ab.balance,
  CAST(1 AS int) AS accountCount,
  CAST(ab.operations AS bigint) AS operations
FROM AccountBalances ab
ORDER BY rowOrder, sectionCode DESC, generalAccountNumber, accountNumber;
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

    const accountRows = rows.filter((row) => asString(row.rowType) === "account");
    const generalRows = rows.filter((row) => asString(row.rowType) === "general");

    const sections = ["products", "expenses"].map((sectionCode) => {
      const sectionLabel = sectionCode === "products" ? "Produits" : "Charges";
      const sectionGenerals = generalRows
        .filter((row) => asString(row.sectionCode) === sectionCode)
        .map((general) => {
          const generalAccountNumber = asString(general.generalAccountNumber);
          const accounts = accountRows
            .filter((account) =>
              asString(account.sectionCode) === sectionCode
              && asString(account.generalAccountNumber) === generalAccountNumber
            )
            .map((account) => ({
              accountNumber: asString(account.accountNumber),
              accountLabel: asString(account.accountLabel),
              balance: asNumber(account.balance),
              operations: asNumber(account.operations),
            }));

          return {
            generalAccountNumber,
            generalAccountLabel: asString(general.generalAccountLabel),
            balance: asNumber(general.balance),
            operations: asNumber(general.operations),
            accountCount: asNumber(general.accountCount),
            accounts,
          };
        });

      return {
        sectionCode,
        sectionLabel,
        total: sectionGenerals.reduce((sum, row) => sum + row.balance, 0),
        generalAccounts: sectionGenerals,
      };
    });

    return NextResponse.json(
      {
        indicator: "resultat",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        exerciseStart: asString(summary.exerciseStart),
        productsTotal: asNumber(summary.productsTotal),
        expensesTotal: asNumber(summary.expensesTotal),
        resultTotal: asNumber(summary.balance),
        accountCount: asNumber(summary.accountCount),
        operations: asNumber(summary.operations),
        sections,
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
    console.error(`[detail/resultat/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
