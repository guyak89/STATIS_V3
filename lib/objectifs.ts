/**
 * lib/objectifs.ts
 * Lecture du fichier objectifs.xlsx et cache mémoire (TTL 60 s).
 * Le fichier Excel doit se trouver à la racine du projet.
 */

import * as XLSX from "xlsx";
import path from "path";
import fs from "fs";

const OBJECTIFS_PATH = path.join(process.cwd(), "objectifs.xlsx");

// Colonnes mois dans le fichier Excel (ordre exact)
const MONTH_COLS = [
  "Janv","Févr","Mars","Avr","Mai","Juin",
  "Juil","Août","Sept","Oct","Nov","Déc",
];

// Mapping nom Excel → slug applicatif
const INDICATOR_MAP: Record<string, string> = {
  "Adhésions":               "adhesions",
  "Encours Crédit":          "encours-credit",
  "Encours Épargne":         "encours-epargne",
  "PAR 1J":                  "par-1j",
  "PAR 30J":                 "par-30j",
  "PAR 90J":                 "par-90j",
  "Résultat":                "resultat",
  "Volume Collecte Tontine": "tontine-collecte",
  "Décaissements":           "decaissements",
  "Impayés":                 "impayes",
  "Stock Crédit en Perte":   "stock-perte",
  "Transféré en Perte":      "transfere-perte",
  "Recouvrement":            "recouvrement",
  "Souscriptions Tontine":   "souscriptions-tontine",
  "Mobile Money":            "mobile-money",
  "Trésorerie":              "tresorerie",
  "Tresorerie":              "tresorerie",
};

/**
 * Indicateurs où une valeur INFÉRIEURE à l'objectif est meilleure.
 * → La réalisation sera calculée différemment pour ces slugs.
 */
export const LOWER_IS_BETTER = new Set<string>([
  "par-1j", "par-30j", "par-90j",
  "impayes", "stock-perte", "transfere-perte",
]);

export type Objectifs = {
  /** slug → objectif mensuel (mois courant) */
  global: Record<string, number>;
  /** code agence → slug → objectif mensuel (mois courant) */
  agence: Record<string, Record<string, number>>;
  /** true si au moins un objectif global est défini */
  hasObjectifs: boolean;
};

// Cache mémoire — invalidé par TTL OU si le fichier Excel a été modifié
const g = global as typeof globalThis & {
  _objectifsCache?: { data: Objectifs; ts: number; fileMtime: number };
};
const TTL = 60_000; // 60 secondes max

/**
 * Calcule le % de réalisation (0–∞, non borné).
 * Pour les indicateurs "lower is better", si actual = 0 → 100%.
 */
export function achievement(actual: number, objectif: number, lowerIsBetter: boolean): number {
  if (!objectif || objectif === 0) return 0;
  if (lowerIsBetter) {
    // 100% = on est exactement à l'objectif, < 100% = on est en dessous (bon)
    return (actual / objectif) * 100;
  }
  return (actual / objectif) * 100;
}

/**
 * Couleur CSS selon le taux de réalisation.
 */
export function achievementColor(rate: number, lowerIsBetter: boolean): "green" | "amber" | "red" {
  if (lowerIsBetter) {
    if (rate <= 100) return "green";
    if (rate <= 125) return "amber";
    return "red";
  }
  if (rate >= 100) return "green";
  if (rate >= 80) return "amber";
  return "red";
}

export function getObjectifs(): Objectifs {
  const empty: Objectifs = { global: {}, agence: {}, hasObjectifs: false };

  if (!fs.existsSync(OBJECTIFS_PATH)) {
    console.warn("[objectifs] Fichier objectifs.xlsx non trouvé à:", OBJECTIFS_PATH);
    return empty;
  }

  // Invalider le cache si le fichier a été modifié (mtime) ou si TTL expiré
  const fileMtime = fs.statSync(OBJECTIFS_PATH).mtimeMs;
  if (
    g._objectifsCache &&
    Date.now() - g._objectifsCache.ts < TTL &&
    g._objectifsCache.fileMtime === fileMtime
  ) {
    return g._objectifsCache.data;
  }

  console.info("[objectifs] (Re)chargement du fichier Excel…");

  try {
    const now = new Date();
    const year = now.getFullYear();
    const monthIdx = now.getMonth(); // 0 = Janv

    const wb = XLSX.readFile(OBJECTIFS_PATH);

    // range: 2  →  row index 2 (0-based) = ligne 3 = vrais en-têtes
    // (les lignes 1-2 sont le titre et la légende)
    const PARSE_OPTIONS = { defval: null, range: 2 } as const;

    /* ── Feuille 1 : Objectifs Globaux ─────────────────────── */
    const global: Record<string, number> = {};
    const gs = wb.Sheets["Objectifs Globaux"];
    if (gs) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(gs, PARSE_OPTIONS);
      for (const row of rows) {
        const label = String(row["Indicateur"] ?? "").trim();
        const slug = INDICATOR_MAP[label];
        if (!slug) continue;
        const rowYear = Number(row["Année"] ?? year);
        if (rowYear !== year) continue;
        const val = row[MONTH_COLS[monthIdx]];
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          const num = Number(val);
          if (!isNaN(num)) global[slug] = num;
        }
      }
    }

    /* ── Feuille 2 : Objectifs par Agence ──────────────────── */
    const agence: Record<string, Record<string, number>> = {};
    const as = wb.Sheets["Objectifs par Agence"];
    if (as) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(as, PARSE_OPTIONS);
      for (const row of rows) {
        const code  = String(row["Code Agence"] ?? "").trim();
        const label = String(row["Indicateur"]  ?? "").trim();
        const slug = INDICATOR_MAP[label];
        if (!slug || !code || code === "XXX") continue;
        const rowYear = Number(row["Année"] ?? year);
        if (rowYear !== year) continue;
        const val = row[MONTH_COLS[monthIdx]];
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          const num = Number(val);
          if (!isNaN(num)) {
            if (!agence[code]) agence[code] = {};
            agence[code][slug] = num;
          }
        }
      }
    }

    const result: Objectifs = {
      global,
      agence,
      hasObjectifs: Object.keys(global).length > 0,
    };
    console.info(`[objectifs] Chargé : ${Object.keys(global).length} objectifs globaux, ${Object.keys(agence).length} agences`);
    g._objectifsCache = { data: result, ts: Date.now(), fileMtime };
    return result;
  } catch (err) {
    console.error("[objectifs] Erreur lecture Excel:", err);
    return empty;
  }
}
