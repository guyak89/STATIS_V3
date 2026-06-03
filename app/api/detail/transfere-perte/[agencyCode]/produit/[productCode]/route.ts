import { NextResponse } from "next/server";
import sql from "mssql";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";
import { CREDIT_LOSS_TRANSFER_CTE } from "@/lib/credit-loss-transfer-sql";
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

function normalizeProductCode(value: string): string {
  return decodeURIComponent(value).trim();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agencyCode: string; productCode: string }> },
) {
  const { agencyCode: rawAgencyCode, productCode: rawProductCode } = await params;
  const agencyCode = normalizeAgencyCode(rawAgencyCode ?? "");
  const productCode = normalizeProductCode(rawProductCode ?? "");

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

  if (!productCode) {
    return NextResponse.json(
      { error: "Code produit manquant." },
      { status: 400 },
    );
  }

  try {
    const requestedAsOfDate = parseAsOfDateParam(req);
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", sql.VarChar(3), agencyCode)
      .input("ProductCode", sql.VarChar(40), productCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

WITH ${CREDIT_LOSS_TRANSFER_CTE},
TransfersWithProduct AS (
  SELECT
    clt.agencyCode,
    clt.numDossier,
    clt.lossTransferNumber,
    CONVERT(varchar(10), clt.lossTransferDate, 23) COLLATE DATABASE_DEFAULT AS lossTransferDate,
    clt.lossEndDate,
    clt.grossOutstanding,
    clt.cautionAmount,
    clt.epgAmount,
    clt.transferredAmount,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_ADH)), ''), '') COLLATE DATABASE_DEFAULT AS customerCode,
    COALESCE(NULLIF(LTRIM(RTRIM(adh.NOM_PRENOM)), ''), 'Client non identifie') COLLATE DATABASE_DEFAULT AS customerName,
    COALESCE(NULLIF(LTRIM(RTRIM(adh.TEL)), ''), NULLIF(LTRIM(RTRIM(adh.NUM_CEL)), ''), '') COLLATE DATABASE_DEFAULT AS phoneNumber
  FROM CreditLossTransfers clt
  LEFT JOIN PRETS p
    ON p.NUM_DOSSIER COLLATE DATABASE_DEFAULT = clt.numDossier COLLATE DATABASE_DEFAULT
  LEFT JOIN DEMPRET dp
    ON dp.REF_DEMANDE COLLATE DATABASE_DEFAULT = p.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD COLLATE DATABASE_DEFAULT = dp.COD_PRDT_CRD COLLATE DATABASE_DEFAULT
  LEFT JOIN ADHERENT adh
    ON adh.COD_ADH COLLATE DATABASE_DEFAULT = dp.COD_ADH COLLATE DATABASE_DEFAULT
  WHERE clt.agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
),
FilteredTransfers AS (
  SELECT *
  FROM TransfersWithProduct
  WHERE productCode COLLATE DATABASE_DEFAULT = @ProductCode COLLATE DATABASE_DEFAULT
)
SELECT
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CONVERT(varchar(10), @MonthStart, 23) COLLATE DATABASE_DEFAULT AS monthStart,
  ft.productCode,
  ft.productName,
  ft.numDossier,
  ft.customerCode,
  ft.customerName,
  ft.phoneNumber,
  ft.lossTransferNumber,
  ft.lossTransferDate,
  ft.grossOutstanding,
  ft.cautionAmount,
  ft.epgAmount,
  ft.transferredAmount
FROM FilteredTransfers ft
JOIN AGENCE a
  ON a.COD_AGENCE COLLATE DATABASE_DEFAULT = ft.agencyCode COLLATE DATABASE_DEFAULT
ORDER BY ft.transferredAmount DESC, ft.numDossier;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const dossiers = rows.map((row) => ({
      numDossier: asString(row.numDossier),
      customerCode: asString(row.customerCode),
      customerName: asString(row.customerName),
      phoneNumber: asString(row.phoneNumber),
      lossTransferNumber: asString(row.lossTransferNumber),
      lossTransferDate: asString(row.lossTransferDate),
      grossOutstanding: asNumber(row.grossOutstanding),
      cautionAmount: asNumber(row.cautionAmount),
      epgAmount: asNumber(row.epgAmount),
      transferredAmount: asNumber(row.transferredAmount),
    }));

    if (dossiers.length === 0) {
      return NextResponse.json(
        { error: `Aucun credit transfere en perte trouve pour le produit ${productCode} dans ${agencyCode}.` },
        { status: 404 },
      );
    }

    const firstRow = rows[0] ?? {};
    const totalTransferred = dossiers.reduce((sum, row) => sum + row.transferredAmount, 0);
    const grossOutstanding = dossiers.reduce((sum, row) => sum + row.grossOutstanding, 0);
    const guaranteesDeducted = dossiers.reduce((sum, row) => sum + row.cautionAmount + row.epgAmount, 0);

    return NextResponse.json(
      {
        indicator: "transfere-perte",
        agencyCode,
        agencyName: asString(firstRow.agencyName),
        asOfDate: asString(firstRow.asOfDate),
        monthStart: asString(firstRow.monthStart),
        productCode: asString(firstRow.productCode),
        productName: asString(firstRow.productName),
        totalTransferred,
        grossOutstanding,
        guaranteesDeducted,
        dossiersCount: dossiers.length,
        dossiers,
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
    console.error(`[detail/transfere-perte/${agencyCode}/produit/${productCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
