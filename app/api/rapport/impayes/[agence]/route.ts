import { NextResponse } from "next/server";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { getPool } from "@/lib/db";
import sql from "mssql";
import { addAsOfDateInput, AS_OF_DATE_SQL, parseAsOfDateParam } from "@/lib/as-of-date";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agence: string }> },
) {
  const { agence } = await params;
  const agenceCode = agence.toUpperCase();

  if (!/^A\d{2}$/.test(agenceCode)) {
    return NextResponse.json({ error: "Code agence invalide." }, { status: 400 });
  }

  const scope = resolveAgencyScope(req);
  if (!isAgencyAllowedByScope(agenceCode, scope)) {
    return NextResponse.json(
      { error: `Agence faitiere exclue par parametrage : "${agenceCode}"` },
      { status: 403 },
    );
  }

  const query = `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}

SELECT
  @AsOfDate                                                           AS dateArret,
  @AgencyCode                                                        AS agenceCode,
  (SELECT RAISON_SOCIAL FROM AGENCE WHERE COD_AGENCE = @AgencyCode) AS agenceNom
;

WITH LossDates AS (
  SELECT
    dh.NUM_DOSSIER,
    MAX(CAST(dh.DATE_DECLAS_HIST AS date)) AS dateDeclasPerte,
    COUNT_BIG(*) AS trpeCount
  FROM DECLAS_HIST dh
  WHERE dh.COD_TYP_OPERAT = 'TRPE'
  GROUP BY dh.NUM_DOSSIER
),
EligibleLoans AS (
  SELECT
    p.NUM_DOSSIER,
    p.REF_DEMANDE,
    p.MONTANT_PRET,
    p.ETAT_PRET
  FROM PRETS p
  LEFT JOIN LossDates ld ON ld.NUM_DOSSIER = p.NUM_DOSSIER
  WHERE LEFT(p.NUM_DOSSIER, 3) = @AgencyCode
    AND p.COD_SRCEFIN NOT IN ('02','07')
    AND (
      (p.ETAT_PRET IN ('DC','SO') AND ISNULL(ld.trpeCount, 0) = 0)
      OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
      OR (p.ETAT_PRET = 'PE' AND ld.dateDeclasPerte > @AsOfDate)
    )
),
DueSchedule AS (
  SELECT
    t.NUM_DOSSIER,
    CAST(t.DATE_ECHEANCE AS date) AS dateEcheance,
    SUM(CAST(ISNULL(t.CAPITAL, 0) AS money)) AS capitalEcheance
  FROM TABAMOR t
  JOIN EligibleLoans el ON el.NUM_DOSSIER = t.NUM_DOSSIER
  WHERE t.DATE_ECHEANCE < @AsOfDate
  GROUP BY t.NUM_DOSSIER, CAST(t.DATE_ECHEANCE AS date)
),
DueCapital AS (
  SELECT
    ds.NUM_DOSSIER,
    SUM(ds.capitalEcheance) AS capitalEchu,
    MAX(ds.dateEcheance) AS derniereEcheanceImpayee
  FROM DueSchedule ds
  GROUP BY ds.NUM_DOSSIER
),
PaidCapital AS (
  SELECT
    rb.NUM_DOSSIER,
    SUM(CAST(ISNULL(rb.CAPITAL_REMB, 0) AS money)) AS capitalRembourse
  FROM REMBOURS rb
  JOIN EligibleLoans el ON el.NUM_DOSSIER = rb.NUM_DOSSIER
  WHERE rb.DATE_REMB <= @AsOfDate
  GROUP BY rb.NUM_DOSSIER
),
DueScheduleCum AS (
  SELECT
    ds.NUM_DOSSIER,
    ds.dateEcheance,
    SUM(ds.capitalEcheance) OVER (
      PARTITION BY ds.NUM_DOSSIER
      ORDER BY ds.dateEcheance
      ROWS UNBOUNDED PRECEDING
    ) AS cumulCapitalEchu
  FROM DueSchedule ds
),
FirstPastDue AS (
  SELECT
    dsc.NUM_DOSSIER,
    MIN(dsc.dateEcheance) AS premiereEcheanceImpayee,
    MAX(dsc.dateEcheance) AS derniereEcheanceImpayee,
    COUNT_BIG(*) AS nbEcheancesImpayees
  FROM DueScheduleCum dsc
  LEFT JOIN PaidCapital pc ON pc.NUM_DOSSIER = dsc.NUM_DOSSIER
  WHERE dsc.cumulCapitalEchu > ISNULL(pc.capitalRembourse, 0)
  GROUP BY dsc.NUM_DOSSIER
),
PastDue AS (
  SELECT
    el.NUM_DOSSIER,
    CASE
      WHEN ISNULL(dc.capitalEchu, 0) - ISNULL(pc.capitalRembourse, 0) > 0
      THEN ISNULL(dc.capitalEchu, 0) - ISNULL(pc.capitalRembourse, 0)
      ELSE 0
    END AS capitalImpaye,
    ISNULL(pc.capitalRembourse, 0) AS capitalRembourse
  FROM EligibleLoans el
  LEFT JOIN DueCapital dc ON dc.NUM_DOSSIER = el.NUM_DOSSIER
  LEFT JOIN PaidCapital pc ON pc.NUM_DOSSIER = el.NUM_DOSSIER
  WHERE ISNULL(dc.capitalEchu, 0) - ISNULL(pc.capitalRembourse, 0) > 0
)
SELECT
  pd.NUM_DOSSIER,
  ISNULL(adh.NOM_PRENOM, '')                                      AS nom,
  ''                                                              AS prenom,
  fp.premiereEcheanceImpayee,
  fp.derniereEcheanceImpayee,
  DATEDIFF(DAY, fp.premiereEcheanceImpayee, @AsOfDate)            AS joursRetard,
  CAST(ISNULL(fp.nbEcheancesImpayees, 0) AS int)                  AS nbEcheancesImpayees,
  pd.capitalImpaye                                                AS capitalImpaye,
  CAST(0 AS money)                                                AS interetImpaye,
  CAST(0 AS money)                                                AS epargneImpayee,
  CAST(0 AS money)                                                AS commissionImpayee,
  pd.capitalImpaye                                                AS totalImpaye,
  ISNULL(el.MONTANT_PRET, 0)                                      AS montantPretInitial,
  CASE
    WHEN ISNULL(el.MONTANT_PRET, 0) - ISNULL(pd.capitalRembourse, 0) < 0 THEN 0
    ELSE ISNULL(el.MONTANT_PRET, 0) - ISNULL(pd.capitalRembourse, 0)
  END                                                            AS capitalRestantDu,
  el.ETAT_PRET                                                    AS etatPret
FROM PastDue pd
JOIN EligibleLoans el ON el.NUM_DOSSIER = pd.NUM_DOSSIER
LEFT JOIN FirstPastDue fp ON fp.NUM_DOSSIER = pd.NUM_DOSSIER
LEFT JOIN DEMPRET dp ON dp.REF_DEMANDE = el.REF_DEMANDE
LEFT JOIN ADHERENT adh ON adh.COD_ADH = dp.COD_ADH
ORDER BY joursRetard DESC, totalImpaye DESC;
`;

  try {
    const requestedAsOfDate = parseAsOfDateParam(req);
    const pool = await getPool();
    const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
      .input("AgencyCode", sql.VarChar(3), agenceCode)
      .query(query);

    const info    = result.recordsets[0]?.[0] ?? null;
    const dossiers = result.recordsets[1] ?? [];

    const totalImpaye        = dossiers.reduce((s: number, r: Record<string, number>) => s + Number(r.totalImpaye ?? 0), 0);
    const totalCapital       = dossiers.reduce((s: number, r: Record<string, number>) => s + Number(r.capitalImpaye ?? 0), 0);
    const totalInteret       = dossiers.reduce((s: number, r: Record<string, number>) => s + Number(r.interetImpaye ?? 0), 0);
    const totalRestantDu     = dossiers.reduce((s: number, r: Record<string, number>) => s + Number(r.capitalRestantDu ?? 0), 0);
    const maxJours           = dossiers.reduce((m: number, r: Record<string, number>) => Math.max(m, Number(r.joursRetard ?? 0)), 0);

    return NextResponse.json({
      agenceCode,
      agenceNom: info?.agenceNom ?? agenceCode,
      dateArret: info?.dateArret,
      totalDossiers: dossiers.length,
      totalImpaye,
      totalCapital,
      totalInteret,
      totalRestantDu,
      maxJoursRetard: maxJours,
      dossiers,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
