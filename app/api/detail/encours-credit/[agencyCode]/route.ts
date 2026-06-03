import { NextResponse } from "next/server";
import sql from "mssql";
import { isAgencyAllowedByScope, resolveAgencyScope } from "@/lib/agency-profiles";
import { getPool } from "@/lib/db";
import { addAsOfDateInput, AS_OF_DATE_SQL, asOfDateCachePart, parseAsOfDateParam } from "@/lib/as-of-date";
import { sqlCache } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SqlRow = Record<string, unknown>;

type BreakdownRow = {
  code: string;
  name: string;
  valeur: number;
  dossiers: number;
  averageAmount: number;
  riskOutstanding: number;
  parRate: number;
};

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function normalizeAgencyCode(value: string): string {
  return decodeURIComponent(value).trim().toUpperCase();
}

function mapBreakdownRows(rows: SqlRow[]): BreakdownRow[] {
  return rows.map((row) => ({
    code: asString(row.code),
    name: asString(row.name),
    valeur: asNumber(row.valeur),
    dossiers: asNumber(row.dossiers),
    averageAmount: asNumber(row.averageAmount),
    riskOutstanding: asNumber(row.riskOutstanding),
    parRate: asNumber(row.parRate),
  }));
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
      `detail:encours-credit:${agencyCode}:${asOfDateCachePart(requestedAsOfDate)}`,
      async () => {
        const pool = await getPool();
        const result = await addAsOfDateInput(pool.request(), requestedAsOfDate)
          .input("AgencyCode", sql.VarChar(3), agencyCode)
          .query(`
SET NOCOUNT ON;

${AS_OF_DATE_SQL}

WITH AgencyLoansBase AS (
  SELECT
    p.NUM_DOSSIER,
    p.MONTANT_PRET,
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
    AND p.NUM_DOSSIER LIKE '%PRT%'
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
    LEFT(p.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT AS agencyCode,
    p.NUM_DOSSIER COLLATE DATABASE_DEFAULT AS NUM_DOSSIER,
    CAST(
      CASE
        WHEN p.MONTANT_PRET - ISNULL(r.capitalRembourse, 0) < 0 THEN 0
        ELSE p.MONTANT_PRET - ISNULL(r.capitalRembourse, 0)
      END
      AS MONEY
    ) AS currentOutstanding,
    COALESCE(NULLIF(LTRIM(RTRIM(p.COD_PRDT_CRD)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS productCode,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), 'Produit non identifie') COLLATE DATABASE_DEFAULT AS productName,
    COALESCE(NULLIF(LTRIM(RTRIM(p.COD_GEST)), ''), 'N/A') COLLATE DATABASE_DEFAULT AS managerCode,
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
    ISNULL(DATEDIFF(DAY, fp.premiereEcheanceImpayee, @AsOfDate), 0) AS joursRetard
  FROM AgencyLoansBase p
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD = p.COD_PRDT_CRD
  LEFT JOIN GESTIONNAIRE g
    ON g.COD_GEST = p.COD_GEST
  LEFT JOIN Remboursements r
    ON r.NUM_DOSSIER = p.NUM_DOSSIER
  LEFT JOIN FirstPastDue fp
    ON fp.NUM_DOSSIER = p.NUM_DOSSIER
  WHERE NOT EXISTS (
    SELECT 1
    FROM LossLoans ll
    WHERE ll.NUM_DOSSIER = p.NUM_DOSSIER
  )
),
ActiveOutstanding AS (
  SELECT *
  FROM LoanPortfolio
  WHERE currentOutstanding > 0
),
SummaryRows AS (
  SELECT
    CAST('summary' AS varchar(10)) COLLATE DATABASE_DEFAULT AS rowType,
    CAST(0 AS int) AS rowOrder,
    a.COD_AGENCE COLLATE DATABASE_DEFAULT AS agencyCode,
    a.RAISON_SOCIAL COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS code,
    CAST(NULL AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    ISNULL(SUM(lo.currentOutstanding), 0) AS valeur,
    CAST(ISNULL(COUNT_BIG(lo.NUM_DOSSIER), 0) AS int) AS dossiers,
    CAST(CASE WHEN COUNT_BIG(lo.NUM_DOSSIER) = 0 THEN 0 ELSE AVG(lo.currentOutstanding) END AS MONEY) AS averageAmount,
    ISNULL(SUM(CASE WHEN lo.joursRetard >= 1 THEN lo.currentOutstanding ELSE 0 END), 0) AS riskOutstanding,
    CAST(
      CASE
        WHEN ISNULL(SUM(lo.currentOutstanding), 0) = 0 THEN 0
        ELSE 100.0 * ISNULL(SUM(CASE WHEN lo.joursRetard >= 1 THEN lo.currentOutstanding ELSE 0 END), 0) / SUM(lo.currentOutstanding)
      END
      AS decimal(18, 4)
    ) AS parRate
  FROM AGENCE a
  LEFT JOIN ActiveOutstanding lo
    ON lo.agencyCode = a.COD_AGENCE
  WHERE a.COD_AGENCE = @AgencyCode
  GROUP BY a.COD_AGENCE, a.RAISON_SOCIAL
),
ProductRows AS (
  SELECT
    CAST('product' AS varchar(10)) COLLATE DATABASE_DEFAULT AS rowType,
    CAST(1 AS int) AS rowOrder,
    CAST(@AgencyCode AS varchar(3)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(NULL AS varchar(100)) COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    productCode AS code,
    CAST(productName AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    SUM(currentOutstanding) AS valeur,
    CAST(COUNT_BIG(NUM_DOSSIER) AS int) AS dossiers,
    AVG(currentOutstanding) AS averageAmount,
    SUM(CASE WHEN joursRetard >= 1 THEN currentOutstanding ELSE 0 END) AS riskOutstanding,
    CAST(
      CASE
        WHEN SUM(currentOutstanding) = 0 THEN 0
        ELSE 100.0 * SUM(CASE WHEN joursRetard >= 1 THEN currentOutstanding ELSE 0 END) / SUM(currentOutstanding)
      END
      AS decimal(18, 4)
    ) AS parRate
  FROM ActiveOutstanding
  GROUP BY productCode, productName
),
ManagerRows AS (
  SELECT
    CAST('manager' AS varchar(10)) COLLATE DATABASE_DEFAULT AS rowType,
    CAST(2 AS int) AS rowOrder,
    CAST(@AgencyCode AS varchar(3)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(NULL AS varchar(100)) COLLATE DATABASE_DEFAULT AS agencyName,
    CONVERT(varchar(10), @AsOfDate, 23) COLLATE DATABASE_DEFAULT AS asOfDate,
    managerCode AS code,
    CAST(managerName AS varchar(120)) COLLATE DATABASE_DEFAULT AS name,
    SUM(currentOutstanding) AS valeur,
    CAST(COUNT_BIG(NUM_DOSSIER) AS int) AS dossiers,
    AVG(currentOutstanding) AS averageAmount,
    SUM(CASE WHEN joursRetard >= 1 THEN currentOutstanding ELSE 0 END) AS riskOutstanding,
    CAST(
      CASE
        WHEN SUM(currentOutstanding) = 0 THEN 0
        ELSE 100.0 * SUM(CASE WHEN joursRetard >= 1 THEN currentOutstanding ELSE 0 END) / SUM(currentOutstanding)
      END
      AS decimal(18, 4)
    ) AS parRate
  FROM ActiveOutstanding
  GROUP BY managerCode, managerName
)
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, code, name, valeur, dossiers, averageAmount, riskOutstanding, parRate
FROM SummaryRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, code, name, valeur, dossiers, averageAmount, riskOutstanding, parRate
FROM ProductRows
UNION ALL
SELECT rowType, rowOrder, agencyCode, agencyName, asOfDate, code, name, valeur, dossiers, averageAmount, riskOutstanding, parRate
FROM ManagerRows
ORDER BY rowOrder, valeur DESC, name
OPTION (RECOMPILE);
`);

        return (result.recordset ?? []) as SqlRow[];
      },
      undefined,
      { forceRefresh },
    );

    const summaryRows = rows.filter((row) => asString(row.rowType) === "summary");
    const productRows = mapBreakdownRows(rows.filter((row) => asString(row.rowType) === "product"));
    const managerRows = mapBreakdownRows(rows.filter((row) => asString(row.rowType) === "manager"));

    if (summaryRows.length === 0) {
      return NextResponse.json(
        { error: `Agence inconnue : "${agencyCode}"` },
        { status: 404 },
      );
    }

    const summary = summaryRows[0];

    return NextResponse.json(
      {
        indicator: "encours-credit",
        label: "Encours Credit",
        unit: "currency",
        agencyCode,
        agencyName: asString(summary.agencyName),
        asOfDate: asString(summary.asOfDate),
        total: asNumber(summary.valeur),
        dossiers: asNumber(summary.dossiers),
        averageAmount: asNumber(summary.averageAmount),
        riskOutstanding: asNumber(summary.riskOutstanding),
        parRate: asNumber(summary.parRate),
        productRows,
        managerRows,
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
    console.error(`[detail/encours-credit/${agencyCode}] Erreur SQL:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
