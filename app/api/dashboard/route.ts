import { NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "@/lib/db";
import {
  getPublicAgencySettings,
} from "@/lib/agency-settings";
import {
  addAgencyScopeInputs,
  agencyScopeSql,
  publicAgencyScope,
  resolveAgencyScope,
  type AgencyScope,
} from "@/lib/agency-profiles";
import { getObjectifs } from "@/lib/objectifs";
import { sqlCache, sqlCacheInvalidate, sqlCachePeek } from "@/lib/sql-cache";
import {
  addAsOfDateInput,
  AS_OF_DATE_SQL,
  asOfDateCachePart,
  parseAsOfDateParam,
} from "@/lib/as-of-date";
import { OVERVIEW_DEFAULTS, OVERVIEW_PARTS, SAVINGS_SQL } from "@/lib/dashboard-overview";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Délai max par bloc SQL. Bien en dessous du requestTimeout du pool (300 s) :
// un bloc lent est annulé et dégradé sans bloquer tout le tableau de bord.
const BLOCK_TIMEOUT_MS = 120_000;

// L'encours d'épargne est l'indicateur le plus lourd (~170 s, rejeu HDPM). Il
// est calculé en arrière-plan, non bloquant, et conservé longtemps en cache.
const SAVINGS_TIMEOUT_MS = 280_000;
const SAVINGS_TTL_MS = 6 * 60 * 60 * 1_000; // 6 h

type MssqlPool = InstanceType<typeof sql.ConnectionPool>;
type MssqlRequest = ReturnType<MssqlPool["request"]>;
type AddInputs = (request: MssqlRequest) => MssqlRequest;

function addAgencyInputs(request: MssqlRequest, scope: AgencyScope) {
  return addAgencyScopeInputs(request, scope);
}

function addDashboardInputs(request: MssqlRequest, scope: AgencyScope, asOfDate: string | null) {
  return addAsOfDateInput(addAgencyInputs(request, scope), asOfDate);
}

type BlockResult = { label: string; ok: boolean; rows: Record<string, unknown>[]; error?: string };

/**
 * Exécute un bloc SQL de façon résiliente : ne rejette jamais (renvoie ok:false),
 * et annule la requête si elle dépasse BLOCK_TIMEOUT_MS afin de ne pas bloquer
 * les autres indicateurs. C'est ce qui permet la dégradation gracieuse.
 */
async function runQueryBlock(
  pool: MssqlPool,
  label: string,
  query: string,
  addInputs: AddInputs,
  timeoutMs: number = BLOCK_TIMEOUT_MS,
): Promise<BlockResult> {
  const request = addInputs(pool.request());
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<Awaited<ReturnType<MssqlRequest["query"]>>>((resolve, reject) => {
      timer = setTimeout(() => {
        try { request.cancel(); } catch { /* ignore */ }
        reject(new Error(`Délai dépassé (${timeoutMs} ms)`));
      }, timeoutMs);
      request.query(query).then(resolve, reject);
    });
    if (timer) clearTimeout(timer);
    console.info(`[dashboard/api] ${label} OK ${Date.now() - startedAt} ms`);
    return { label, ok: true, rows: (result.recordset as Record<string, unknown>[]) ?? [] };
  } catch (error) {
    if (timer) clearTimeout(timer);
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    console.error(`[dashboard/api] ${label} FAIL ${Date.now() - startedAt} ms :: ${message}`);
    return { label, ok: false, rows: [], error: message };
  }
}

/**
 * Lance (ou réutilise) le calcul de l'encours d'épargne en arrière-plan. Le
 * `pending` de sqlCache déduplique les appels concurrents, et la promesse n'est
 * pas attendue : le tableau de bord n'est jamais bloqué par cet indicateur lourd.
 */
function triggerSavingsCompute(
  savingsKey: string,
  scope: AgencyScope,
  asOfDate: string | null,
): void {
  void sqlCache(
    savingsKey,
    async () => {
      const pool = await getPool();
      const res = await runQueryBlock(
        pool,
        "overview:savings",
        SAVINGS_SQL,
        (r) => addDashboardInputs(r, scope, asOfDate),
        SAVINGS_TIMEOUT_MS,
      );
      if (!res.ok || !res.rows[0]) {
        throw new Error(res.error ?? "Encours d'épargne indisponible.");
      }
      return res.rows[0];
    },
    SAVINGS_TTL_MS,
  ).catch(() => { /* sera réessayé au prochain chargement */ });
}

const adherentTrendQuery = `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
SELECT
  FORMAT(DATEFROMPARTS(YEAR(a.DATE_INSCRIP), MONTH(a.DATE_INSCRIP), 1), 'yyyy-MM') AS label,
  CAST(COUNT_BIG(*) AS int) AS total
FROM ADHERENT a
WHERE a.DATE_INSCRIP >= DATEADD(MONTH, -12, @AsOfDate)
  AND a.DATE_INSCRIP < DATEADD(DAY, 1, @AsOfDate)
  AND ${agencyScopeSql("a.COD_AGENCE")}
GROUP BY DATEFROMPARTS(YEAR(a.DATE_INSCRIP), MONTH(a.DATE_INSCRIP), 1)
ORDER BY 1;
`;

// agencyPerformance : même logique de portefeuille que la requête d'origine,
// mais les parties partagées sont matérialisées en #temp (les CTE n'étaient pas
// matérialisés → recalcul du portefeuille à chaque référence). Sous charge
// concurrente, cette requête passait de ~25 s à ~95 s ; la version #temp la
// ramène à ~25 s. Résultat identique (vérifié : sumLoanAmount = portefeuille global).
const agencyPerfQuery = `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}

SELECT rb.NUM_DOSSIER, SUM(CAST(ISNULL(rb.CAPITAL_REMB,0) AS MONEY)) AS capitalRembourse
INTO #ApRemb FROM REMBOURS rb WHERE rb.DATE_REMB <= @AsOfDate GROUP BY rb.NUM_DOSSIER;
CREATE CLUSTERED INDEX ix ON #ApRemb(NUM_DOSSIER);

SELECT NUM_DOSSIER INTO #ApLoss FROM (
  SELECT dh.NUM_DOSSIER, dh.COD_TYP_OPERAT,
    ROW_NUMBER() OVER (PARTITION BY dh.NUM_DOSSIER ORDER BY dh.DATE_DECLAS_HIST DESC, dh.NUM_TRANS DESC) AS rn
  FROM DECLAS_HIST dh
  WHERE dh.DATE_DECLAS_HIST <= @AsOfDate AND (dh.DATE_FIN IS NULL OR dh.DATE_FIN > @AsOfDate)
) x WHERE x.rn = 1 AND x.COD_TYP_OPERAT = 'TRPE';
CREATE CLUSTERED INDEX ix ON #ApLoss(NUM_DOSSIER);

SELECT DISTINCT dh.NUM_DOSSIER INTO #ApFuture FROM DECLAS_HIST dh
WHERE dh.COD_TYP_OPERAT = 'TRPE' AND dh.DATE_DECLAS_HIST > @AsOfDate;
CREATE CLUSTERED INDEX ix ON #ApFuture(NUM_DOSSIER);

SELECT LEFT(p.NUM_DOSSIER,3) AS agencyCode,
  CASE WHEN p.MONTANT_PRET - ISNULL(r.capitalRembourse,0) < 0 THEN 0
       ELSE p.MONTANT_PRET - ISNULL(r.capitalRembourse,0) END AS currentOutstanding
INTO #ApPortfolio
FROM PRETS p LEFT JOIN #ApRemb r ON r.NUM_DOSSIER = p.NUM_DOSSIER
WHERE (   (p.ETAT_PRET IN ('SO','DC') AND (p.DATE_SOLDE IS NULL OR p.DATE_SOLDE > @AsOfDate))
       OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
       OR (p.ETAT_PRET = 'PE' AND EXISTS (SELECT 1 FROM #ApFuture f WHERE f.NUM_DOSSIER = p.NUM_DOSSIER)))
  AND p.NUM_DOSSIER LIKE '%PRT%'
  AND EXISTS (SELECT 1 FROM DECAIS dc WHERE dc.NUM_DOSSIER = p.NUM_DOSSIER AND dc.DATE_DECAIS <= @AsOfDate)
  AND NOT EXISTS (SELECT 1 FROM #ApLoss ll WHERE ll.NUM_DOSSIER = p.NUM_DOSSIER)
  AND ${agencyScopeSql("LEFT(p.NUM_DOSSIER, 3)")};

SELECT
  a.COD_AGENCE    AS agencyCode,
  a.RAISON_SOCIAL AS agencyName,
  ISNULL(adh.adherents,0)  AS adherents,
  ISNULL(loa.loans,0)      AS loans,
  ISNULL(loa.loanAmount,0) AS loanAmount
FROM AGENCE a
LEFT JOIN (
  SELECT d.COD_AGENCE, CAST(COUNT_BIG(*) AS int) AS adherents
  FROM ADHERENT d WHERE ${agencyScopeSql("d.COD_AGENCE")} GROUP BY d.COD_AGENCE
) adh ON adh.COD_AGENCE = a.COD_AGENCE
LEFT JOIN (
  SELECT agencyCode, CAST(COUNT_BIG(*) AS int) AS loans,
    SUM(CAST(ISNULL(currentOutstanding,0) AS MONEY)) AS loanAmount
  FROM #ApPortfolio GROUP BY agencyCode
) loa ON loa.agencyCode = a.COD_AGENCE
WHERE ${agencyScopeSql("a.COD_AGENCE")}
ORDER BY ISNULL(adh.adherents,0) DESC;

DROP TABLE #ApRemb, #ApLoss, #ApFuture, #ApPortfolio;
`;

const loanStatusQuery = `
SET NOCOUNT ON;
SELECT TOP 6
  p.ETAT_PRET AS statusCode,
  CAST(COUNT_BIG(*) AS int) AS totalLoans,
  SUM(CAST(ISNULL(p.MONTANT_PRET,0) AS MONEY)) AS totalAmount
FROM PRETS p
WHERE ${agencyScopeSql("LEFT(p.NUM_DOSSIER, 3)")}
GROUP BY p.ETAT_PRET
ORDER BY COUNT_BIG(*) DESC;
`;

const decaissTrendQuery = `
SET NOCOUNT ON;
${AS_OF_DATE_SQL}
SELECT
  FORMAT(DATEFROMPARTS(YEAR(d.DATE_DECAIS), MONTH(d.DATE_DECAIS), 1), 'yyyy-MM') AS label,
  SUM(CAST(ISNULL(d.MONTANT_DECAIS,0) AS MONEY)) AS total,
  CAST(COUNT_BIG(*) AS int)                       AS count
FROM DECAIS d
WHERE d.DATE_DECAIS >= DATEADD(MONTH, -6, @AsOfDate)
  AND d.DATE_DECAIS <= @AsOfDate
  AND ${agencyScopeSql("LEFT(d.NUM_DOSSIER, 3)")}
GROUP BY DATEFROMPARTS(YEAR(d.DATE_DECAIS), MONTH(d.DATE_DECAIS), 1)
ORDER BY 1;
`;

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const forceRefresh = searchParams.has("refresh");

  try {
    const requestedAsOfDate = parseAsOfDateParam(req);
    const scope = resolveAgencyScope(req);
    const agencySettings = {
      ...getPublicAgencySettings(),
      ...publicAgencyScope(scope),
    };
    const scopeCachePart = scope.profileActive
      ? `profile-${scope.activeProfile?.id ?? "unknown"}-${scope.agencyCodes.join("_")}`
      : `${scope.centralAgencyCode}:${scope.includeCentralAgency ? "with-faitiere" : "without-faitiere"}`;
    const cacheKey = `dashboard:${scopeCachePart}:${asOfDateCachePart(requestedAsOfDate)}`;

    const sqlData = await sqlCache(
      cacheKey,
      async () => {
        const pool = await getPool();
        const addDash: AddInputs = (r) => addDashboardInputs(r, scope, requestedAsOfDate);
        const addAg: AddInputs = (r) => addAgencyInputs(r, scope);

        // Tous les blocs (carte overview découpée + 4 indicateurs) tournent en
        // parallèle et indépendamment : l'échec ou la lenteur d'un bloc ne fait
        // plus échouer tout le tableau de bord.
        const results = await Promise.all([
          ...OVERVIEW_PARTS.map((part) => runQueryBlock(pool, part.label, part.sql, addDash)),
          runQueryBlock(pool, "adherentTrend", adherentTrendQuery, addDash),
          runQueryBlock(pool, "agencyPerformance", agencyPerfQuery, addDash),
          runQueryBlock(pool, "loanStatus", loanStatusQuery, addAg),
          runQueryBlock(pool, "decaissementTrend", decaissTrendQuery, addDash),
        ]);

        // Échec total (base injoignable, date historique future rejetée par le
        // THROW SQL, etc.) : on propage l'erreur → 500 avec message clair, et
        // rien n'est mis en cache. Un échec partiel, lui, dégrade gracieusement.
        if (results.every((r) => !r.ok)) {
          throw new Error(results.find((r) => r.error)?.error ?? "Échec des requêtes du tableau de bord.");
        }

        const byLabel = new Map(results.map((r) => [r.label, r]));

        // Fusion des blocs overview : on part des valeurs neutres et on applique
        // chaque bloc réussi. Un bloc en échec laisse ses champs à 0/null.
        const overview: Record<string, unknown> = { ...OVERVIEW_DEFAULTS };
        for (const part of OVERVIEW_PARTS) {
          const row = byLabel.get(part.label)?.rows[0];
          if (row) Object.assign(overview, row);
        }

        const failedBlocks = results.filter((r) => !r.ok).map((r) => r.label);

        return {
          overview,
          adherentTrend:      byLabel.get("adherentTrend")?.rows ?? [],
          agencyPerformance:  byLabel.get("agencyPerformance")?.rows ?? [],
          loanStatus:         byLabel.get("loanStatus")?.rows ?? [],
          decaissementTrend:  byLabel.get("decaissementTrend")?.rows ?? [],
          degraded:           failedBlocks.length > 0,
          failedBlocks,
        };
      },
      undefined,
      { forceRefresh },
    );

    // Un résultat partiel (un ou plusieurs blocs en échec) ne doit pas rester
    // figé en cache 4 min : on l'invalide pour que la requête suivante réessaie.
    if (sqlData.degraded) {
      sqlCacheInvalidate(cacheKey);
    }

    // Encours d'épargne : superposé depuis son propre cache (calcul d'arrière-
    // plan, voir triggerSavingsCompute). Absent au tout premier chargement → la
    // carte affiche « À calculer », puis la valeur apparaît une fois le calcul
    // terminé (et reste en cache plusieurs heures).
    const savingsKey = `savings:${scopeCachePart}:${asOfDateCachePart(requestedAsOfDate)}`;
    const savingsRow = sqlCachePeek<Record<string, unknown>>(savingsKey);
    if (!savingsRow) {
      triggerSavingsCompute(savingsKey, scope, requestedAsOfDate);
    }
    const overview = savingsRow
      ? {
          ...sqlData.overview,
          totalSavingsAmount: savingsRow.totalSavingsAmount ?? null,
          savingsSnapshotPeriod: savingsRow.savingsSnapshotPeriod ?? null,
        }
      : sqlData.overview;

    const { global: objectifs, hasObjectifs } = getObjectifs();

    return NextResponse.json(
      { ...sqlData, overview, objectifs, hasObjectifs, agencySettings },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    console.error("[dashboard/api] Erreur SQL:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
