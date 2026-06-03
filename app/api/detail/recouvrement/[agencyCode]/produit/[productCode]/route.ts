import { NextResponse } from "next/server";
import sql from "mssql";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";

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

WITH Recouvrements AS (
  SELECT
    LEFT(cp.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT AS agencyCode,
    cp.NUM_DOSSIER COLLATE DATABASE_DEFAULT AS numDossier,
    cp.NUM_TRANS COLLATE DATABASE_DEFAULT AS numTrans,
    CAST(ISNULL(cp.MONTANT, 0) AS MONEY) AS montantRecouvre,
    CAST(cp.DATE_OPERATION AS date) AS dateOperation,
    cp.COD_MODE_PAIE COLLATE DATABASE_DEFAULT AS modePaiement,
    cp.COD_UTIL COLLATE DATABASE_DEFAULT AS utilisateur,
    cp.KP_CAIS_AGENCE COLLATE DATABASE_DEFAULT AS cashDeskKey,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_ADH)), ''), '') COLLATE DATABASE_DEFAULT AS customerCode,
    COALESCE(NULLIF(LTRIM(RTRIM(adh.NOM_PRENOM)), ''), 'Client non identifie') COLLATE DATABASE_DEFAULT AS customerName
  FROM CREDIT_PERTE cp
  LEFT JOIN PRETS p
    ON p.NUM_DOSSIER COLLATE DATABASE_DEFAULT = cp.NUM_DOSSIER COLLATE DATABASE_DEFAULT
  LEFT JOIN DEMPRET dp
    ON dp.REF_DEMANDE COLLATE DATABASE_DEFAULT = p.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD COLLATE DATABASE_DEFAULT = dp.COD_PRDT_CRD COLLATE DATABASE_DEFAULT
  LEFT JOIN ADHERENT adh
    ON adh.COD_ADH COLLATE DATABASE_DEFAULT = dp.COD_ADH COLLATE DATABASE_DEFAULT
  WHERE LEFT(cp.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND cp.DATE_OPERATION >= @MonthStart
    AND cp.DATE_OPERATION <= @AsOfDate
),
FilteredRecouvrements AS (
  SELECT *
  FROM Recouvrements
  WHERE productCode COLLATE DATABASE_DEFAULT = @ProductCode COLLATE DATABASE_DEFAULT
),
DossierRows AS (
  SELECT
    fr.agencyCode,
    fr.numDossier,
    MAX(fr.customerCode) AS customerCode,
    MAX(fr.customerName) AS customerName,
    MAX(fr.productCode) AS productCode,
    MAX(fr.productName) AS productName,
    SUM(fr.montantRecouvre) AS montantRecouvre,
    CAST(COUNT_BIG(*) AS int) AS operations,
    MIN(fr.dateOperation) AS firstOperationDate,
    MAX(fr.dateOperation) AS lastOperationDate,
    MAX(fr.modePaiement) AS modePaiement,
    MAX(fr.utilisateur) AS utilisateur,
    MAX(fr.cashDeskKey) AS cashDeskKey
  FROM FilteredRecouvrements fr
  GROUP BY fr.agencyCode, fr.numDossier
)
SELECT
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CONVERT(varchar(10), @MonthStart, 23) COLLATE DATABASE_DEFAULT AS monthStart,
  dr.productCode,
  dr.productName,
  dr.numDossier,
  dr.customerCode,
  dr.customerName,
  dr.montantRecouvre,
  dr.operations,
  CONVERT(varchar(10), dr.firstOperationDate, 23) COLLATE DATABASE_DEFAULT AS firstOperationDate,
  CONVERT(varchar(10), dr.lastOperationDate, 23) COLLATE DATABASE_DEFAULT AS lastOperationDate,
  dr.modePaiement,
  dr.utilisateur,
  dr.cashDeskKey
FROM DossierRows dr
JOIN AGENCE a
  ON a.COD_AGENCE COLLATE DATABASE_DEFAULT = dr.agencyCode COLLATE DATABASE_DEFAULT
ORDER BY dr.montantRecouvre DESC, dr.numDossier;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const dossiers = rows.map((row) => ({
      numDossier: asString(row.numDossier),
      customerCode: asString(row.customerCode),
      customerName: asString(row.customerName),
      montantRecouvre: asNumber(row.montantRecouvre),
      operations: asNumber(row.operations),
      firstOperationDate: asString(row.firstOperationDate),
      lastOperationDate: asString(row.lastOperationDate),
      modePaiement: asString(row.modePaiement),
      utilisateur: asString(row.utilisateur),
      cashDeskKey: asString(row.cashDeskKey),
    }));

    if (dossiers.length === 0) {
      return NextResponse.json(
        { error: `Aucun dossier recouvre trouve pour le produit ${productCode} dans ${agencyCode}.` },
        { status: 404 },
      );
    }

    const firstRow = rows[0] ?? {};
    const totalRecouvre = dossiers.reduce((sum, row) => sum + row.montantRecouvre, 0);
    const operations = dossiers.reduce((sum, row) => sum + row.operations, 0);

    return NextResponse.json(
      {
        indicator: "recouvrement",
        agencyCode,
        agencyName: asString(firstRow.agencyName),
        asOfDate: asString(firstRow.asOfDate),
        monthStart: asString(firstRow.monthStart),
        productCode: asString(firstRow.productCode),
        productName: asString(firstRow.productName),
        totalRecouvre,
        operations,
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
    console.error(`[detail/recouvrement/${agencyCode}/produit/${productCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
