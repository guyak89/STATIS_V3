import { NextResponse } from "next/server";
import sql from "mssql";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";
import { CREDIT_LOSS_STOCK_CTE } from "@/lib/credit-loss-stock-sql";
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

WITH ${CREDIT_LOSS_STOCK_CTE},
StockWithProduct AS (
  SELECT
    cls.agencyCode,
    cls.numDossier,
    cls.lossTransferNumber,
    CONVERT(varchar(10), cls.lossTransferDate, 23) COLLATE DATABASE_DEFAULT AS lossTransferDate,
    cls.initialLossOutstanding,
    cls.recoveredAmount,
    cls.stockAmount,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_ADH)), ''), '') COLLATE DATABASE_DEFAULT AS customerCode,
    COALESCE(NULLIF(LTRIM(RTRIM(adh.NOM_PRENOM)), ''), 'Client non identifie') COLLATE DATABASE_DEFAULT AS customerName,
    COALESCE(NULLIF(LTRIM(RTRIM(adh.TEL)), ''), NULLIF(LTRIM(RTRIM(adh.NUM_CEL)), ''), '') COLLATE DATABASE_DEFAULT AS phoneNumber
  FROM CreditLossStock cls
  LEFT JOIN PRETS p
    ON p.NUM_DOSSIER COLLATE DATABASE_DEFAULT = cls.numDossier COLLATE DATABASE_DEFAULT
  LEFT JOIN DEMPRET dp
    ON dp.REF_DEMANDE COLLATE DATABASE_DEFAULT = p.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD COLLATE DATABASE_DEFAULT = dp.COD_PRDT_CRD COLLATE DATABASE_DEFAULT
  LEFT JOIN ADHERENT adh
    ON adh.COD_ADH COLLATE DATABASE_DEFAULT = dp.COD_ADH COLLATE DATABASE_DEFAULT
  WHERE cls.agencyCode COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
),
FilteredStock AS (
  SELECT *
  FROM StockWithProduct
  WHERE productCode COLLATE DATABASE_DEFAULT = @ProductCode COLLATE DATABASE_DEFAULT
)
SELECT
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  fs.productCode,
  fs.productName,
  fs.numDossier,
  fs.customerCode,
  fs.customerName,
  fs.phoneNumber,
  fs.lossTransferNumber,
  fs.lossTransferDate,
  fs.initialLossOutstanding,
  fs.recoveredAmount,
  fs.stockAmount
FROM FilteredStock fs
JOIN AGENCE a
  ON a.COD_AGENCE COLLATE DATABASE_DEFAULT = fs.agencyCode COLLATE DATABASE_DEFAULT
ORDER BY fs.stockAmount DESC, fs.numDossier;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const dossiers = rows.map((row) => ({
      numDossier: asString(row.numDossier),
      customerCode: asString(row.customerCode),
      customerName: asString(row.customerName),
      phoneNumber: asString(row.phoneNumber),
      lossTransferNumber: asString(row.lossTransferNumber),
      lossTransferDate: asString(row.lossTransferDate),
      initialLossOutstanding: asNumber(row.initialLossOutstanding),
      recoveredAmount: asNumber(row.recoveredAmount),
      stockAmount: asNumber(row.stockAmount),
    }));

    if (dossiers.length === 0) {
      return NextResponse.json(
        { error: `Aucun credit en perte trouve pour le produit ${productCode} dans ${agencyCode}.` },
        { status: 404 },
      );
    }

    const firstRow = rows[0] ?? {};
    const totalStock = dossiers.reduce((sum, row) => sum + row.stockAmount, 0);
    const initialLossOutstanding = dossiers.reduce((sum, row) => sum + row.initialLossOutstanding, 0);
    const recoveredAmount = dossiers.reduce((sum, row) => sum + row.recoveredAmount, 0);

    return NextResponse.json(
      {
        indicator: "stock-perte",
        agencyCode,
        agencyName: asString(firstRow.agencyName),
        asOfDate: asString(firstRow.asOfDate),
        productCode: asString(firstRow.productCode),
        productName: asString(firstRow.productName),
        totalStock,
        initialLossOutstanding,
        recoveredAmount,
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
    console.error(`[detail/stock-perte/${agencyCode}/produit/${productCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
