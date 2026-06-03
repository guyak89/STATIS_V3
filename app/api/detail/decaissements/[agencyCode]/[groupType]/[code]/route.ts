import { NextResponse } from "next/server";
import sql from "mssql";
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

function normalizeGroupType(value: string): "product" | "manager" | null {
  const normalized = decodeURIComponent(value).trim().toLowerCase();
  if (normalized === "produit" || normalized === "product") return "product";
  if (normalized === "gestionnaire" || normalized === "manager") return "manager";
  return null;
}

function publicGroupType(value: "product" | "manager"): "produit" | "gestionnaire" {
  return value === "product" ? "produit" : "gestionnaire";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agencyCode: string; groupType: string; code: string }> },
) {
  const { agencyCode: rawAgencyCode, groupType: rawGroupType, code: rawCode } = await params;
  const agencyCode = normalizeAgencyCode(rawAgencyCode ?? "");
  const groupType = normalizeGroupType(rawGroupType ?? "");
  const groupCode = decodeURIComponent(rawCode ?? "").trim();

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

  if (!groupType) {
    return NextResponse.json(
      { error: `Type de regroupement invalide : "${rawGroupType}"` },
      { status: 400 },
    );
  }

  if (!groupCode) {
    return NextResponse.json(
      { error: "Code produit ou gestionnaire manquant." },
      { status: 400 },
    );
  }

  try {
    const requestedAsOfDate = parseAsOfDateParam(req);
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", sql.VarChar(3), agencyCode)
      .input("GroupType", sql.VarChar(10), groupType)
      .input("GroupCode", sql.VarChar(40), groupCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

WITH Decaissements AS (
  SELECT
    LEFT(d.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT AS agencyCode,
    d.NUM_DOSSIER COLLATE DATABASE_DEFAULT AS numDossier,
    d.NUM_TRANS COLLATE DATABASE_DEFAULT AS numTrans,
    CAST(ISNULL(d.MONTANT_DECAIS, 0) AS money) AS montantDecaisse,
    CAST(d.DATE_DECAIS AS date) AS dateDecaissement,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_GEST)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS managerCode,
    COALESCE(
      NULLIF(
        LTRIM(RTRIM(CONCAT(
          ISNULL(g.NOM, ''),
          CASE
            WHEN NULLIF(LTRIM(RTRIM(g.PRENOM)), '') IS NULL THEN ''
            ELSE ' ' + LTRIM(RTRIM(g.PRENOM))
          END
        ))),
        ''
      ),
      'Gestionnaire non identifie'
    ) COLLATE DATABASE_DEFAULT AS managerName,
    COALESCE(NULLIF(LTRIM(RTRIM(dp.COD_ADH)), ''), '') COLLATE DATABASE_DEFAULT AS customerCode,
    COALESCE(NULLIF(LTRIM(RTRIM(adh.NOM_PRENOM)), ''), 'Client non identifie') COLLATE DATABASE_DEFAULT AS customerName,
    COALESCE(NULLIF(LTRIM(RTRIM(adh.TEL)), ''), NULLIF(LTRIM(RTRIM(adh.NUM_CEL)), ''), '') COLLATE DATABASE_DEFAULT AS phoneNumber
  FROM DECAIS d
  JOIN PRETS p
    ON p.NUM_DOSSIER COLLATE DATABASE_DEFAULT = d.NUM_DOSSIER COLLATE DATABASE_DEFAULT
  JOIN DEMPRET dp
    ON dp.REF_DEMANDE COLLATE DATABASE_DEFAULT = p.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD COLLATE DATABASE_DEFAULT = dp.COD_PRDT_CRD COLLATE DATABASE_DEFAULT
  LEFT JOIN GESTIONNAIRE g
    ON g.COD_GEST COLLATE DATABASE_DEFAULT = dp.COD_GEST COLLATE DATABASE_DEFAULT
  LEFT JOIN ADHERENT adh
    ON adh.COD_ADH COLLATE DATABASE_DEFAULT = dp.COD_ADH COLLATE DATABASE_DEFAULT
  WHERE LEFT(d.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT
    AND d.DATE_DECAIS >= @MonthStart
    AND d.DATE_DECAIS <= @AsOfDate
),
FilteredDecaissements AS (
  SELECT *
  FROM Decaissements
  WHERE
    (@GroupType = 'product' AND productCode COLLATE DATABASE_DEFAULT = @GroupCode COLLATE DATABASE_DEFAULT)
    OR (@GroupType = 'manager' AND managerCode COLLATE DATABASE_DEFAULT = @GroupCode COLLATE DATABASE_DEFAULT)
),
DossierRows AS (
  SELECT
    fd.agencyCode,
    fd.numDossier,
    MAX(fd.customerCode) AS customerCode,
    MAX(fd.customerName) AS customerName,
    MAX(fd.phoneNumber) AS phoneNumber,
    MAX(fd.productCode) AS productCode,
    MAX(fd.productName) AS productName,
    MAX(fd.managerCode) AS managerCode,
    MAX(fd.managerName) AS managerName,
    SUM(fd.montantDecaisse) AS montantDecaisse,
    CAST(COUNT_BIG(*) AS int) AS operations,
    MIN(fd.dateDecaissement) AS firstDecaissementDate,
    MAX(fd.dateDecaissement) AS lastDecaissementDate,
    MAX(fd.numTrans) AS lastTransactionNumber
  FROM FilteredDecaissements fd
  GROUP BY fd.agencyCode, fd.numDossier
)
SELECT
  a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
  a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
  CONVERT(varchar(10), @MonthStart, 23) COLLATE DATABASE_DEFAULT AS monthStart,
  CASE WHEN @GroupType = 'product' THEN dr.productCode ELSE dr.managerCode END AS groupCode,
  CASE WHEN @GroupType = 'product' THEN dr.productName ELSE dr.managerName END AS groupName,
  dr.numDossier,
  dr.customerCode,
  dr.customerName,
  dr.phoneNumber,
  dr.productCode,
  dr.productName,
  dr.managerCode,
  dr.managerName,
  dr.montantDecaisse,
  dr.operations,
  CONVERT(varchar(10), dr.firstDecaissementDate, 23) COLLATE DATABASE_DEFAULT AS firstDecaissementDate,
  CONVERT(varchar(10), dr.lastDecaissementDate, 23) COLLATE DATABASE_DEFAULT AS lastDecaissementDate,
  dr.lastTransactionNumber
FROM DossierRows dr
JOIN AGENCE a
  ON a.COD_AGENCE COLLATE DATABASE_DEFAULT = dr.agencyCode COLLATE DATABASE_DEFAULT
ORDER BY dr.montantDecaisse DESC, dr.numDossier;
`);

    const rows = (result.recordset ?? []) as SqlRow[];
    const dossiers = rows.map((row) => ({
      numDossier: asString(row.numDossier),
      customerCode: asString(row.customerCode),
      customerName: asString(row.customerName),
      phoneNumber: asString(row.phoneNumber),
      productCode: asString(row.productCode),
      productName: asString(row.productName),
      managerCode: asString(row.managerCode),
      managerName: asString(row.managerName),
      montantDecaisse: asNumber(row.montantDecaisse),
      operations: asNumber(row.operations),
      firstDecaissementDate: asString(row.firstDecaissementDate),
      lastDecaissementDate: asString(row.lastDecaissementDate),
      lastTransactionNumber: asString(row.lastTransactionNumber),
    }));

    if (dossiers.length === 0) {
      return NextResponse.json(
        { error: `Aucun dossier decaisse trouve pour ${publicGroupType(groupType)} ${groupCode} dans ${agencyCode}.` },
        { status: 404 },
      );
    }

    const firstRow = rows[0] ?? {};
    const totalDecaisse = dossiers.reduce((sum, row) => sum + row.montantDecaisse, 0);
    const operations = dossiers.reduce((sum, row) => sum + row.operations, 0);

    return NextResponse.json(
      {
        indicator: "decaissements",
        agencyCode,
        agencyName: asString(firstRow.agencyName),
        asOfDate: asString(firstRow.asOfDate),
        monthStart: asString(firstRow.monthStart),
        groupType: publicGroupType(groupType),
        groupCode: asString(firstRow.groupCode),
        groupName: asString(firstRow.groupName),
        totalDecaisse,
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
    console.error(`[detail/decaissements/${agencyCode}/${rawGroupType}/${groupCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
