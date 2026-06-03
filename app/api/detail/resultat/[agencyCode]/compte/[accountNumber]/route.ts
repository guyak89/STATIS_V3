import sql from "mssql";
import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";
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

function normalizeAccountNumber(value: string): string {
  return decodeURIComponent(value).trim().toUpperCase();
}

function parseDateParam(req: Request, name: string): string | null {
  const value = new URL(req.url).searchParams.get(name)?.trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Format de date invalide pour ${name}. Utilisez AAAA-MM-JJ.`);
  }
  return value;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agencyCode: string; accountNumber: string }> },
) {
  const { agencyCode: rawAgencyCode, accountNumber: rawAccountNumber } = await params;
  const agencyCode = normalizeAgencyCode(rawAgencyCode ?? "");
  const accountNumber = normalizeAccountNumber(rawAccountNumber ?? "");

  if (!/^[A-Z0-9]{3}$/.test(agencyCode)) {
    return NextResponse.json(
      { error: `Code agence invalide : "${agencyCode}"` },
      { status: 400 },
    );
  }

  if (!accountNumber || accountNumber.length > 40) {
    return NextResponse.json(
      { error: `Compte invalide : "${accountNumber}"` },
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
    const requestedStartDate = parseDateParam(req, "startDate");
    const requestedEndDate = parseDateParam(req, "endDate");
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("RequestedStartDate", sql.Date, requestedStartDate)
      .input("RequestedEndDate", sql.Date, requestedEndDate)
      .input("AgencyCode", sql.VarChar(10), agencyCode)
      .input("AccountNumber", sql.VarChar(40), accountNumber)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @DefaultStartDate date = DATEFROMPARTS(YEAR(@AsOfDate), 1, 1);
DECLARE @StartDate date = ISNULL(@RequestedStartDate, @DefaultStartDate);
DECLARE @EndDate date = ISNULL(@RequestedEndDate, @AsOfDate);

IF @StartDate > @EndDate
  THROW 51001, 'La date de debut du grand livre ne peut pas etre posterieure a la date de fin.', 1;

IF @EndDate > @AsOfDate
  THROW 51002, 'La date de fin du grand livre ne peut pas depasser la date d''arret.', 1;

WITH AccountInfo AS (
  SELECT TOP (1)
    a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
    c.NUM_CPTE COLLATE DATABASE_DEFAULT AS accountNumber,
    COALESCE(NULLIF(LTRIM(RTRIM(c.INTITULE_CPTE)), ''), c.NUM_CPTE) COLLATE DATABASE_DEFAULT AS accountLabel,
    c.CPTE_GAL COLLATE DATABASE_DEFAULT AS generalAccountNumber,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.LIB_CPTE_GAL)), ''), c.CPTE_GAL) COLLATE DATABASE_DEFAULT AS generalAccountLabel
  FROM COMPTES c
  JOIN AGENCE a
    ON a.COD_AGENCE COLLATE DATABASE_DEFAULT = c.COD_AGENCE COLLATE DATABASE_DEFAULT
  LEFT JOIN PLANCPTE pc
    ON pc.CPTE_GAL COLLATE DATABASE_DEFAULT = c.CPTE_GAL COLLATE DATABASE_DEFAULT
  WHERE c.COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND c.NUM_CPTE COLLATE DATABASE_DEFAULT = @AccountNumber COLLATE DATABASE_DEFAULT
    AND (c.NUM_CPTE LIKE '6%' OR c.NUM_CPTE LIKE '7%')
),
Opening AS (
  SELECT
    CAST(ISNULL(SUM(CASE
      WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0)
      WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS, 0)
      ELSE 0
    END), 0) AS money) AS openingBalance
  FROM AccountInfo ai
  LEFT JOIN HDPM h
    ON h.NUM_CPTE COLLATE DATABASE_DEFAULT = ai.accountNumber COLLATE DATABASE_DEFAULT
   AND h.DATE_OPERATION < @StartDate
),
Entries AS (
  SELECT
    h.HDPM_CLE AS entryKey,
    h.NUM_LIGNE AS lineNumber,
    CAST(h.DATE_OPERATION AS date) AS operationDate,
    h.NUM_PIECE COLLATE DATABASE_DEFAULT AS pieceNumber,
    h.NUM_PIECE_MANUEL COLLATE DATABASE_DEFAULT AS manualPieceNumber,
    h.NUM_MVT COLLATE DATABASE_DEFAULT AS movementNumber,
    h.COD_TYP_OPERAT COLLATE DATABASE_DEFAULT AS operationType,
    h.DESCRIPTION COLLATE DATABASE_DEFAULT AS description,
    h.SENS_OPERATION COLLATE DATABASE_DEFAULT AS direction,
    CAST(CASE WHEN h.SENS_OPERATION = 'D' THEN ISNULL(h.MONTANT_TRANS, 0) ELSE 0 END AS money) AS debit,
    CAST(CASE WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0) ELSE 0 END AS money) AS credit,
    CAST(CASE
      WHEN h.SENS_OPERATION = 'C' THEN ISNULL(h.MONTANT_TRANS, 0)
      WHEN h.SENS_OPERATION = 'D' THEN -ISNULL(h.MONTANT_TRANS, 0)
      ELSE 0
    END AS money) AS signedAmount
  FROM AccountInfo ai
  JOIN HDPM h
    ON h.NUM_CPTE COLLATE DATABASE_DEFAULT = ai.accountNumber COLLATE DATABASE_DEFAULT
  WHERE h.DATE_OPERATION >= @StartDate
    AND h.DATE_OPERATION < DATEADD(DAY, 1, @EndDate)
)
SELECT
  CAST('summary' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  ai.agencyCode,
  ai.agencyName,
  ai.accountNumber,
  ai.accountLabel,
  ai.generalAccountNumber,
  ai.generalAccountLabel,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CONVERT(varchar(10), @DefaultStartDate, 23) COLLATE DATABASE_DEFAULT AS defaultStartDate,
  CONVERT(varchar(10), @StartDate, 23) COLLATE DATABASE_DEFAULT AS startDate,
  CONVERT(varchar(10), @EndDate, 23) COLLATE DATABASE_DEFAULT AS endDate,
  op.openingBalance,
  CAST(ISNULL(SUM(e.debit), 0) AS money) AS periodDebit,
  CAST(ISNULL(SUM(e.credit), 0) AS money) AS periodCredit,
  CAST(op.openingBalance + ISNULL(SUM(e.signedAmount), 0) AS money) AS closingBalance,
  CAST(COUNT_BIG(e.entryKey) AS bigint) AS operations,
  CAST(NULL AS int) AS entryKey,
  CAST(NULL AS int) AS lineNumber,
  CAST(NULL AS varchar(10)) COLLATE DATABASE_DEFAULT AS operationDate,
  CAST(NULL AS varchar(60)) COLLATE DATABASE_DEFAULT AS pieceNumber,
  CAST(NULL AS varchar(60)) COLLATE DATABASE_DEFAULT AS manualPieceNumber,
  CAST(NULL AS varchar(60)) COLLATE DATABASE_DEFAULT AS movementNumber,
  CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationType,
  CAST(NULL AS nvarchar(500)) COLLATE DATABASE_DEFAULT AS description,
  CAST(NULL AS varchar(1)) COLLATE DATABASE_DEFAULT AS direction,
  CAST(NULL AS money) AS debit,
  CAST(NULL AS money) AS credit,
  CAST(NULL AS money) AS signedAmount,
  CAST(NULL AS money) AS runningBalance
FROM AccountInfo ai
CROSS JOIN Opening op
LEFT JOIN Entries e ON 1 = 1
GROUP BY
  ai.agencyCode, ai.agencyName, ai.accountNumber, ai.accountLabel,
  ai.generalAccountNumber, ai.generalAccountLabel, op.openingBalance

UNION ALL

SELECT
  CAST('entry' AS varchar(20)) COLLATE DATABASE_DEFAULT AS rowType,
  ai.agencyCode,
  ai.agencyName,
  ai.accountNumber,
  ai.accountLabel,
  ai.generalAccountNumber,
  ai.generalAccountLabel,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CONVERT(varchar(10), @DefaultStartDate, 23) COLLATE DATABASE_DEFAULT AS defaultStartDate,
  CONVERT(varchar(10), @StartDate, 23) COLLATE DATABASE_DEFAULT AS startDate,
  CONVERT(varchar(10), @EndDate, 23) COLLATE DATABASE_DEFAULT AS endDate,
  op.openingBalance,
  CAST(NULL AS money) AS periodDebit,
  CAST(NULL AS money) AS periodCredit,
  CAST(NULL AS money) AS closingBalance,
  CAST(NULL AS bigint) AS operations,
  e.entryKey,
  e.lineNumber,
  CONVERT(varchar(10), e.operationDate, 23) COLLATE DATABASE_DEFAULT AS operationDate,
  e.pieceNumber,
  e.manualPieceNumber,
  e.movementNumber,
  e.operationType,
  e.description,
  e.direction,
  e.debit,
  e.credit,
  e.signedAmount,
  CAST(op.openingBalance + SUM(e.signedAmount) OVER (
    ORDER BY e.operationDate, e.pieceNumber, e.lineNumber, e.entryKey
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS money) AS runningBalance
FROM AccountInfo ai
CROSS JOIN Opening op
JOIN Entries e ON 1 = 1
ORDER BY rowType DESC, operationDate, pieceNumber, lineNumber, entryKey;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const summary = rows.find((row) => asString(row.rowType) === "summary");

    if (!summary) {
      return NextResponse.json(
        { error: `Compte resultat introuvable pour ${agencyCode} : "${accountNumber}"` },
        { status: 404 },
      );
    }

    const entries = rows
      .filter((row) => asString(row.rowType) === "entry")
      .map((row) => ({
        entryKey: asNumber(row.entryKey),
        lineNumber: asNumber(row.lineNumber),
        operationDate: asString(row.operationDate),
        pieceNumber: asString(row.manualPieceNumber) || asString(row.pieceNumber) || asString(row.movementNumber),
        systemPieceNumber: asString(row.pieceNumber),
        movementNumber: asString(row.movementNumber),
        operationType: asString(row.operationType),
        description: asString(row.description),
        direction: asString(row.direction),
        debit: asNumber(row.debit),
        credit: asNumber(row.credit),
        signedAmount: asNumber(row.signedAmount),
        runningBalance: asNumber(row.runningBalance),
      }));

    return NextResponse.json(
      {
        indicator: "resultat",
        agencyCode,
        agencyName: asString(summary.agencyName),
        accountNumber,
        accountLabel: asString(summary.accountLabel),
        generalAccountNumber: asString(summary.generalAccountNumber),
        generalAccountLabel: asString(summary.generalAccountLabel),
        asOfDate: asString(summary.asOfDate),
        defaultStartDate: asString(summary.defaultStartDate),
        startDate: asString(summary.startDate),
        endDate: asString(summary.endDate),
        openingBalance: asNumber(summary.openingBalance),
        periodDebit: asNumber(summary.periodDebit),
        periodCredit: asNumber(summary.periodCredit),
        closingBalance: asNumber(summary.closingBalance),
        operations: asNumber(summary.operations),
        entries,
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
    console.error(`[detail/resultat/${agencyCode}/compte/${accountNumber}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
