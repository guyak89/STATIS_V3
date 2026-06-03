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
      .input("GroupCode", sql.VarChar(30), groupCode)
      .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH AgencyLoansBase AS (
  SELECT
    p.NUM_DOSSIER,
    p.REF_DEMANDE,
    p.MONTANT_PRET,
    p.ETAT_PRET,
    p.DATE_SOLDE,
    dp.COD_ADH,
    dp.COD_PRDT_CRD,
    dp.COD_GEST
  FROM PRETS p
  JOIN DEMPRET dp
    ON dp.REF_DEMANDE = p.REF_DEMANDE
  WHERE p.NUM_DOSSIER LIKE @AgencyCode + 'PRT%'
    AND (
      (
        p.ETAT_PRET IN ('SO', 'DC')
        AND (p.DATE_SOLDE IS NULL OR p.DATE_SOLDE > @AsOfDate)
      )
      OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
      OR (
        p.ETAT_PRET = 'PE'
        AND EXISTS (
          SELECT 1
          FROM DECLAS_HIST dhPe
          WHERE dhPe.NUM_DOSSIER = p.NUM_DOSSIER
            AND dhPe.COD_TYP_OPERAT = 'TRPE'
            AND dhPe.DATE_DECLAS_HIST > @AsOfDate
        )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM DECAIS dc
      WHERE dc.NUM_DOSSIER = p.NUM_DOSSIER
        AND dc.DATE_DECAIS <= @AsOfDate
    )
),
DeclassementRanked AS (
  SELECT
    dh.NUM_DOSSIER,
    dh.COD_TYP_OPERAT,
    ROW_NUMBER() OVER (
      PARTITION BY dh.NUM_DOSSIER
      ORDER BY dh.DATE_DECLAS_HIST DESC, dh.NUM_TRANS DESC
    ) AS rn
  FROM DECLAS_HIST dh
  WHERE dh.NUM_DOSSIER LIKE @AgencyCode + 'PRT%'
    AND dh.DATE_DECLAS_HIST <= @AsOfDate
    AND (dh.DATE_FIN IS NULL OR dh.DATE_FIN > @AsOfDate)
),
LossLoans AS (
  SELECT dr.NUM_DOSSIER
  FROM DeclassementRanked dr
  WHERE dr.rn = 1
    AND dr.COD_TYP_OPERAT = 'TRPE'
),
Remboursements AS (
  SELECT
    rb.NUM_DOSSIER,
    SUM(CAST(ISNULL(rb.CAPITAL_REMB, 0) AS MONEY)) AS capitalRembourse
  FROM REMBOURS rb
  WHERE rb.NUM_DOSSIER LIKE @AgencyCode + 'PRT%'
    AND rb.DATE_REMB <= @AsOfDate
  GROUP BY rb.NUM_DOSSIER
),
RemboursementsParEcheance AS (
  SELECT
    rb.NUM_DOSSIER,
    CAST(rb.DATE_ECHEANCE AS date) AS dateEcheance,
    SUM(CAST(ISNULL(rb.CAPITAL_REMB, 0) AS MONEY)) AS capitalRembourseEcheance
  FROM REMBOURS rb
  WHERE rb.NUM_DOSSIER LIKE @AgencyCode + 'PRT%'
    AND rb.DATE_REMB <= @AsOfDate
  GROUP BY rb.NUM_DOSSIER, CAST(rb.DATE_ECHEANCE AS date)
),
Decaissements AS (
  SELECT
    dc.NUM_DOSSIER,
    SUM(CAST(ISNULL(dc.MONTANT_DECAIS, 0) AS MONEY)) AS montantDecaisse,
    MIN(CAST(dc.DATE_DECAIS AS date)) AS dateDecaissement
  FROM DECAIS dc
  WHERE dc.NUM_DOSSIER LIKE @AgencyCode + 'PRT%'
    AND dc.DATE_DECAIS <= @AsOfDate
  GROUP BY dc.NUM_DOSSIER
),
DueSchedule AS (
  SELECT
    t.NUM_DOSSIER,
    CAST(t.DATE_ECHEANCE AS date) AS dateEcheance,
    SUM(CAST(ISNULL(t.CAPITAL, 0) AS MONEY)) AS capitalEcheance
  FROM TABAMOR t
  WHERE t.NUM_DOSSIER LIKE @AgencyCode + 'PRT%'
    AND t.DATE_ECHEANCE < @AsOfDate
  GROUP BY t.NUM_DOSSIER, CAST(t.DATE_ECHEANCE AS date)
),
DueCapital AS (
  SELECT
    ds.NUM_DOSSIER,
    SUM(ds.capitalEcheance) AS capitalEchu
  FROM DueSchedule ds
  GROUP BY ds.NUM_DOSSIER
),
FirstPastDue AS (
  SELECT
    ds.NUM_DOSSIER,
    MIN(ds.dateEcheance) AS premiereEcheanceImpayee
  FROM DueSchedule ds
  JOIN DueCapital dc
    ON dc.NUM_DOSSIER = ds.NUM_DOSSIER
  LEFT JOIN Remboursements rb
    ON rb.NUM_DOSSIER = ds.NUM_DOSSIER
  LEFT JOIN RemboursementsParEcheance rbe
    ON rbe.NUM_DOSSIER = ds.NUM_DOSSIER
   AND rbe.dateEcheance = ds.dateEcheance
  WHERE dc.capitalEchu > ISNULL(rb.capitalRembourse, 0)
    AND ds.capitalEcheance > ISNULL(rbe.capitalRembourseEcheance, 0)
  GROUP BY ds.NUM_DOSSIER
),
LoanPortfolio AS (
  SELECT
    LEFT(p.NUM_DOSSIER, 3) AS agencyCode,
    p.NUM_DOSSIER,
    ISNULL(adh.NOM_PRENOM, '') AS clientName,
    ISNULL(dec.montantDecaisse, 0) AS montantDecaisse,
    CONVERT(varchar(10), dec.dateDecaissement, 23) AS dateDecaissement,
    CAST(
      CASE
        WHEN p.MONTANT_PRET - ISNULL(r.capitalRembourse, 0) < 0 THEN 0
        ELSE p.MONTANT_PRET - ISNULL(r.capitalRembourse, 0)
      END
      AS MONEY
    ) AS currentOutstanding,
    COALESCE(NULLIF(LTRIM(RTRIM(p.COD_PRDT_CRD)), ''), 'N/A') AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') AS productName,
    COALESCE(NULLIF(LTRIM(RTRIM(p.COD_GEST)), ''), 'N/A') AS managerCode,
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
    ) AS managerName,
    p.ETAT_PRET AS etatPret,
    CASE
      WHEN p.ETAT_PRET = 'DC' AND ISNULL(DATEDIFF(DAY, fp.premiereEcheanceImpayee, @AsOfDate), 0) >= 1 THEN 'En retard'
      WHEN p.ETAT_PRET = 'DC' THEN 'Sain'
      WHEN p.ETAT_PRET = 'SO' THEN 'Souffrant'
      WHEN p.ETAT_PRET = 'SD' THEN 'Solde apres date arret'
      WHEN p.ETAT_PRET = 'PE' THEN 'Perte apres date arret'
      ELSE p.ETAT_PRET
    END AS etatLibelle,
    ISNULL(DATEDIFF(DAY, fp.premiereEcheanceImpayee, @AsOfDate), 0) AS joursRetard
  FROM AgencyLoansBase p
  LEFT JOIN ADHERENT adh
    ON adh.COD_ADH = p.COD_ADH
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD = p.COD_PRDT_CRD
  LEFT JOIN GESTIONNAIRE g
    ON g.COD_GEST = p.COD_GEST
  LEFT JOIN Remboursements r
    ON r.NUM_DOSSIER = p.NUM_DOSSIER
  LEFT JOIN Decaissements dec
    ON dec.NUM_DOSSIER = p.NUM_DOSSIER
  LEFT JOIN FirstPastDue fp
    ON fp.NUM_DOSSIER = p.NUM_DOSSIER
  WHERE NOT EXISTS (
    SELECT 1
    FROM LossLoans ll
    WHERE ll.NUM_DOSSIER = p.NUM_DOSSIER
  )
),
FilteredLoans AS (
  SELECT *
  FROM LoanPortfolio
  WHERE currentOutstanding > 0
    AND (
      (@GroupType = 'product' AND productCode = @GroupCode)
      OR (@GroupType = 'manager' AND managerCode = @GroupCode)
    )
)
SELECT
  fl.agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  CONVERT(varchar(10), @AsOfDate, 23) AS asOfDate,
  CASE WHEN @GroupType = 'product' THEN fl.productCode ELSE fl.managerCode END AS groupCode,
  CASE WHEN @GroupType = 'product' THEN fl.productName ELSE fl.managerName END AS groupName,
  fl.NUM_DOSSIER AS numDossier,
  fl.clientName,
  fl.montantDecaisse,
  fl.dateDecaissement,
  fl.currentOutstanding,
  fl.joursRetard,
  fl.etatPret,
  fl.etatLibelle
FROM FilteredLoans fl
JOIN AGENCE a
  ON a.COD_AGENCE = fl.agencyCode
ORDER BY fl.currentOutstanding DESC, fl.NUM_DOSSIER;
`);

    const dossiers = ((result.recordset ?? []) as SqlRow[]).map((row) => ({
      numDossier: asString(row.numDossier),
      clientName: asString(row.clientName),
      montantDecaisse: asNumber(row.montantDecaisse),
      dateDecaissement: asString(row.dateDecaissement),
      currentOutstanding: asNumber(row.currentOutstanding),
      joursRetard: asNumber(row.joursRetard),
      etatPret: asString(row.etatPret),
      etatLibelle: asString(row.etatLibelle),
    }));

    if (dossiers.length === 0) {
      return NextResponse.json(
        { error: `Aucun dossier trouve pour ${publicGroupType(groupType)} ${groupCode} dans ${agencyCode}.` },
        { status: 404 },
      );
    }

    const firstRow = (result.recordset[0] ?? {}) as SqlRow;
    const totalEncours = dossiers.reduce((sum, row) => sum + row.currentOutstanding, 0);
    const totalDecaisse = dossiers.reduce((sum, row) => sum + row.montantDecaisse, 0);
    const maxJoursRetard = dossiers.reduce((max, row) => Math.max(max, row.joursRetard), 0);

    return NextResponse.json(
      {
        indicator: "encours-credit",
        agencyCode,
        agencyName: asString(firstRow.agencyName),
        asOfDate: asString(firstRow.asOfDate),
        groupType: publicGroupType(groupType),
        groupCode: asString(firstRow.groupCode),
        groupName: asString(firstRow.groupName),
        totalEncours,
        totalDecaisse,
        dossiersCount: dossiers.length,
        maxJoursRetard,
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
    console.error(`[detail/encours-credit/${agencyCode}/${rawGroupType}/${groupCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
