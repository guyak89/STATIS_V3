/**
 * lib/sql-cache.ts
 * Cache mémoire serveur pour les résultats SQL lourds.
 * TTL par défaut : 4 minutes (en dessous du rafraîchissement SWR à 10 min).
 *
 * Usage :
 *   const data = await sqlCache("dashboard", async () => { ... calcul SQL ... });
 */

const DEFAULT_TTL_MS = 4 * 60 * 1_000; // 4 minutes

type CacheEntry<T> = {
  data?: T;
  expiresAt: number;
  pending?: Promise<T>;
};

const g = global as typeof globalThis & {
  _sqlCache?: Map<string, CacheEntry<unknown>>;
};

function getStore(): Map<string, CacheEntry<unknown>> {
  if (!g._sqlCache) g._sqlCache = new Map();
  return g._sqlCache;
}

/**
 * Lit le cache pour `key`. Si absent ou expiré, exécute `fn()`,
 * stocke le résultat et le retourne.
 */
export async function sqlCache<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
  opts: { forceRefresh?: boolean } = {},
): Promise<T> {
  const store = getStore();
  const now = Date.now();
  const entry = store.get(key) as CacheEntry<T> | undefined;

  // Anti-stampede : une requête (même forcée) rejoint toujours une exécution
  // déjà en cours plutôt que d'en lancer une nouvelle en parallèle. Sans cela,
  // plusieurs "refresh" simultanés (navigateur + SWR + retries) déclenchaient
  // chacun une exécution complète, saturant la base.
  if (entry?.pending) {
    console.info(`[sql-cache] WAIT ${key} (requete deja en cours)`);
    return entry.pending;
  }

  if (!opts.forceRefresh && entry && entry.data !== undefined && now < entry.expiresAt) {
    console.info(`[sql-cache] HIT  ${key} (expire dans ${Math.round((entry.expiresAt - now) / 1000)} s)`);
    return entry.data;
  }

  console.info(`[sql-cache] MISS ${key} — exécution requête SQL…`);
  const pending = fn()
    .then((data) => {
      store.set(key, { data, expiresAt: Date.now() + ttlMs });
      return data;
    })
    .catch((error) => {
      store.delete(key);
      throw error;
    });

  store.set(key, {
    data: entry?.data,
    expiresAt: entry?.expiresAt ?? 0,
    pending,
  });

  return pending;
}

/**
 * Lecture synchrone du cache sans déclencher de calcul : renvoie la donnée si
 * elle est présente et non expirée, sinon undefined. Utilisé pour superposer un
 * indicateur calculé en arrière-plan (ex : encours d'épargne) sans bloquer.
 */
export function sqlCachePeek<T>(key: string): T | undefined {
  const entry = getStore().get(key) as CacheEntry<T> | undefined;
  if (entry && entry.data !== undefined && Date.now() < entry.expiresAt) {
    return entry.data;
  }
  return undefined;
}

/**
 * Invalide manuellement une entrée (ex : après une mise à jour).
 */
export function sqlCacheInvalidate(key: string) {
  getStore().delete(key);
}

/**
 * Invalide toutes les entrées du cache.
 */
export function sqlCacheClear() {
  getStore().clear();
}
