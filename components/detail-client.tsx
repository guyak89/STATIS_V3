"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  Area, AreaChart,
  Bar, BarChart, CartesianGrid, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useMemo } from "react";
import type { ValueType } from "recharts/types/component/DefaultTooltipContent";
import { useBranding } from "@/components/app-branding";
import { exportDetailToExcel } from "@/lib/excel-export";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

/* ═══════════════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════════════ */

type DetailRow = {
  agencyCode: string;
  agencyName: string;
  valeur: number;
  count?: number;
  cashInAmount?: number;
  cashOutAmount?: number;
  rate?: number;
  totalPortfolio?: number;
  totalStock?: number;
  objectif?: number | null;
};

type TrendPoint = { label: string; total: number };

type DetailPayload = {
  indicator: string;
  label: string;
  unit: "currency" | "count" | "percent";
  hasRate: boolean;
  total: number;
  rows: DetailRow[];
  trend: TrendPoint[] | null;
  objectifGlobal: number | null;
  objectifAgence: Record<string, number>;
  lowerIsBetter: boolean;
  hasObjectifs: boolean;
};

/* ═══════════════════════════════════════════════════════════════
   FORMATTERS
═══════════════════════════════════════════════════════════════ */

const fmtCurrency = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "XOF", maximumFractionDigits: 0 });
const fmtCompact  = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const fmtInt      = new Intl.NumberFormat("fr-FR");
const fmtPct      = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtMonth = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit" });

function labelToDate(label: string) {
  const [y, m] = label.split("-");
  return new Date(Number(y), Number(m) - 1, 1);
}
function shortMonth(label: string) {
  return fmtMonth.format(labelToDate(label));
}

function formatValue(v: number, unit: string) {
  if (unit === "currency") return fmtCurrency.format(v);
  if (unit === "percent")  return `${fmtPct.format(v)} %`;
  return fmtInt.format(v);
}

function toNumber(value: ValueType | null | undefined) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function formatCompact(v: number, unit: string) {
  if (unit === "currency") return fmtCompact.format(v) + " XOF";
  return fmtCompact.format(v);
}

/* ═══════════════════════════════════════════════════════════════
   ICON MAP
═══════════════════════════════════════════════════════════════ */

const INDICATOR_ICONS: Record<string, string> = {
  "adhesions":           "👥",
  "encours-credit":      "🏦",
  "encours-epargne":     "💰",
  "par-1j":              "📊",
  "par-30j":             "📊",
  "par-90j":             "📊",
  "resultat":            "📈",
  "tontine-collecte":    "🤝",
  "decaissements":       "💸",
  "impayes":             "⚠️",
  "stock-perte":         "📉",
  "transfere-perte":     "↘️",
  "recouvrement":        "↗️",
  "mobile-money":        "MM",
  "tresorerie":          "T",
  "souscriptions-tontine": "📋",
};

const INDICATOR_ACCENT: Record<string, string> = {
  "adhesions":           "var(--teal)",
  "encours-credit":      "var(--blue)",
  "encours-epargne":     "var(--green)",
  "par-1j":              "var(--amber)",
  "par-30j":             "var(--amber)",
  "par-90j":             "var(--red)",
  "resultat":            "var(--purple)",
  "tontine-collecte":    "var(--teal)",
  "decaissements":       "var(--blue)",
  "impayes":             "var(--amber)",
  "stock-perte":         "var(--red)",
  "transfere-perte":     "var(--red)",
  "recouvrement":        "var(--green)",
  "mobile-money":        "var(--blue)",
  "tresorerie":          "var(--green)",
  "souscriptions-tontine": "var(--purple)",
};

/* ═══════════════════════════════════════════════════════════════
   FETCHER
═══════════════════════════════════════════════════════════════ */

const fetcher = async (url: string): Promise<DetailPayload> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

/* ═══════════════════════════════════════════════════════════════
   OBJECTIF HELPERS
═══════════════════════════════════════════════════════════════ */

function objPct(actual: number, objectif: number): number {
  if (!objectif || objectif === 0) return 0;
  return (actual / objectif) * 100;
}

function objColorClass(
  pct: number,
  lowerIsBetter: boolean,
): "obj-green" | "obj-amber" | "obj-red" {
  if (lowerIsBetter) {
    if (pct <= 100) return "obj-green";
    if (pct <= 125) return "obj-amber";
    return "obj-red";
  }
  if (pct >= 100) return "obj-green";
  if (pct >= 80)  return "obj-amber";
  return "obj-red";
}

function ObjAchievementCell({
  actual, objectif, unit, lowerIsBetter,
}: {
  actual: number; objectif: number; unit: string; lowerIsBetter: boolean;
}) {
  const p = objPct(actual, objectif);
  const cls = objColorClass(p, lowerIsBetter);
  const bar = lowerIsBetter ? Math.min(p, 150) / 1.5 : Math.min(p, 100);
  const fmtObjVal = unit === "currency"
    ? fmtCurrency.format(objectif)
    : unit === "percent"
    ? `${fmtPct.format(objectif)} %`
    : fmtInt.format(objectif);

  return (
    <td className="td-num" style={{ textAlign: "right", minWidth: 140 }}>
      <div className="obj-cell-wrap">
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", marginBottom: 3 }}>
          <span style={{ color: "var(--text-muted)" }}>{fmtObjVal}</span>
          <span className={`obj-pct ${cls}`}>{fmtPct.format(p)} %</span>
        </div>
        <div className="obj-bar-track" style={{ height: 5 }}>
          <div className={`obj-bar-fill ${cls}`} style={{ width: `${bar}%` }} />
        </div>
      </div>
    </td>
  );
}

/* ═══════════════════════════════════════════════════════════════
   BAR COLORS — dégradé par rang
═══════════════════════════════════════════════════════════════ */

function barFill(indicator: string, index: number, total: number): string {
  const baseColors: Record<string, [number, number, number]> = {
    "adhesions":           [122, 31, 43],
    "encours-credit":      [63, 127, 164],
    "encours-epargne":     [168, 50, 70],
    "par-1j":              [215, 139, 31],
    "par-30j":             [215, 139, 31],
    "par-90j":             [194, 65, 59],
    "resultat":            [141, 90, 143],
    "tontine-collecte":    [122, 31, 43],
    "decaissements":       [63, 127, 164],
    "impayes":             [215, 139, 31],
    "stock-perte":         [194, 65, 59],
    "transfere-perte":     [194, 65, 59],
    "recouvrement":        [168, 50, 70],
    "mobile-money":        [63, 127, 164],
    "tresorerie":          [168, 50, 70],
    "souscriptions-tontine": [141, 90, 143],
  };
  const [r, g, b] = baseColors[indicator] ?? [122, 31, 43];
  const opacity = Math.max(0.3, 1 - (index / (total || 1)) * 0.55);
  return `rgba(${r},${g},${b},${opacity})`;
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════ */

export function DetailClient({ indicator }: { indicator: string }) {
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailApiUrl = withAsOfDate(`/api/detail/${indicator}`, asOfDate);
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailApiUrl,
    fetcher,
    { revalidateOnFocus: false },
  );

  /* ── Données triées par valeur décroissante ── */
  const sortedRows = useMemo(
    () => [...(data?.rows ?? [])].sort((a, b) => b.valeur - a.valeur),
    [data?.rows],
  );

  const icon   = INDICATOR_ICONS[indicator]  ?? "📌";
  const accent = INDICATOR_ACCENT[indicator] ?? "var(--teal)";
  const label  = data?.label ?? decodeIndicator(indicator);
  const unit   = data?.unit  ?? "currency";

  /* ── Total et part max ── */
  const maxValeur      = sortedRows[0]?.valeur ?? 1;
  const lowerIsBetter  = data?.lowerIsBetter ?? false;
  const objectifGlobal = data?.objectifGlobal ?? null;
  const objectifAgence = data?.objectifAgence ?? {};
  const hasObjectifs   = data?.hasObjectifs ?? false;
  const agencyDrilldownLabel = indicator === "encours-credit"
    ? "Par produit et gestionnaire"
    : indicator === "encours-epargne"
    ? "Par produit"
    : indicator === "resultat"
    ? "Charges et produits"
    : indicator === "tontine-collecte"
    ? "Dispatch par agent collecteur"
    : indicator === "decaissements"
    ? "Par produit et gestionnaire"
    : indicator === "stock-perte"
    ? "Par produit de credit"
    : indicator === "transfere-perte"
    ? "Par produit de credit"
    : indicator === "recouvrement"
    ? "Par produit de credit"
    : indicator === "souscriptions-tontine"
    ? "Par agent collecteur"
    : indicator === "operations-caisse"
    ? "Par caisse"
    : indicator === "mobile-money"
    ? "Depots et retraits"
    : null;
  const countColumnLabel = indicator === "stock-perte"
    ? "Dossiers"
    : indicator === "transfere-perte"
    ? "Dossiers"
    : indicator === "tresorerie"
    ? "Comptes"
    : "Opérations";
  const showInOutColumns = indicator === "operations-caisse" || indicator === "mobile-money" || indicator === "tresorerie";
  const inColumnLabel = indicator === "mobile-money"
    ? "Dépôts"
    : indicator === "tresorerie"
    ? "Caisses"
    : "Entrées";
  const outColumnLabel = indicator === "mobile-money"
    ? "Retraits"
    : indicator === "tresorerie"
    ? "Banques"
    : "Sorties";

  /* ── Header commun ── */
  const header = (
    <header className="app-header">
      <Link href={detailHref("/")} className="back-btn" title="Retour au tableau de bord">
        ← Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo" style={{ background: `linear-gradient(135deg, ${accent}, var(--blue))` }}>
          {icon}
        </div>
        <div>
          <div className="brand-name">{label}</div>
          <div className="brand-sub">Détail par Mutuelle / Agence</div>
        </div>
      </div>
    </header>
  );

  /* ── Error ── */
  if (error) {
    return (
      <div className="app">
        {header}
        <div className="app-content">
          <div className="panel">
            <div className="error-panel">
              <div className="error-icon">⚠️</div>
              <div className="error-title">Erreur lors du chargement du détail</div>
              <div className="error-detail">{String(error?.message ?? error)}</div>
              <div className="error-code">{String(error?.message ?? error)}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Loading ── */
  if (isLoading || !data) {
    return (
      <div className="app">
        {header}
        <div className="app-content">
          <div className="skeleton-grid">
            {[0,1,2,3].map(i => <div key={i} className="skeleton-card" />)}
          </div>
          <div className="skeleton-panel" />
          <div className="skeleton-panel" style={{ height: 400 }} />
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════
     DETAIL PAGE
  ══════════════════════════════════════════════════════════ */
  return (
    <div className="app">
      {header}

      <div className="app-content fade-in">

        {/* ── Synthèse ── */}
        <div className="detail-summary-row">
          <div className="detail-summary-card" style={{ borderTopColor: accent }}>
            <div className="detail-summary-icon">{icon}</div>
            <div className="detail-summary-label">Total consolidé</div>
            <div className="detail-summary-value">{formatValue(data.total, unit)}</div>
            <div className="detail-summary-sub">{sortedRows.length} agence(s) avec données</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">🏆</div>
            <div className="detail-summary-label">Meilleure agence</div>
            <div className="detail-summary-value" style={{ fontSize: "1.4rem" }}>
              {sortedRows[0]?.agencyName ?? "—"}
            </div>
            <div className="detail-summary-sub">{sortedRows[0]?.agencyCode ?? "—"}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--purple)" }}>
            <div className="detail-summary-icon">📊</div>
            <div className="detail-summary-label">Valeur maximale</div>
            <div className="detail-summary-value">{formatValue(maxValeur, unit)}</div>
            <div className="detail-summary-sub">Parmi toutes les agences</div>
          </div>

          {/* ── Objectif global (si défini) ── */}
          {objectifGlobal !== null ? (() => {
            const p = objPct(data.total, objectifGlobal);
            const cls = objColorClass(p, lowerIsBetter);
            const barFillPct = lowerIsBetter ? Math.min(p, 150) / 1.5 : Math.min(p, 100);
            const statusLabel = lowerIsBetter
              ? (p <= 100 ? "✓ Sous l'objectif" : "↑ Au-dessus objectif")
              : (p >= 100 ? "✓ Objectif atteint" : "En cours…");
            return (
              <div className={`detail-summary-card obj-summary-card ${cls}`} style={{ borderTopColor: cls === "obj-green" ? "var(--objective-green)" : cls === "obj-amber" ? "var(--objective-amber)" : "var(--objective-red)" }}>
                <div className="detail-summary-icon">🎯</div>
                <div className="detail-summary-label">Vs Objectif global</div>
                <div className={`detail-summary-value obj-achievement-val ${cls}`}>
                  {fmtPct.format(p)} %
                </div>
                <div className="obj-global-bar-track">
                  <div className={`obj-bar-fill ${cls}`} style={{ width: `${barFillPct}%` }} />
                </div>
                <div className="detail-summary-sub">
                  Obj : {formatValue(objectifGlobal, unit)} · {statusLabel}
                </div>
              </div>
            );
          })() : (
            <div className="detail-summary-card obj-no-obj-card" style={{ borderTopColor: "var(--border-md)" }}>
              <div className="detail-summary-icon">🎯</div>
              <div className="detail-summary-label">Objectif global</div>
              <div className="detail-summary-value" style={{ fontSize: "1rem", color: "var(--text-muted)" }}>
                Non défini
              </div>
              <div className="detail-summary-sub">
                Renseignez l&apos;objectif dans <code>objectifs.xlsx</code>
              </div>
            </div>
          )}

          {data.hasRate && (
            <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
              <div className="detail-summary-icon">⚖️</div>
              <div className="detail-summary-label">Taux global</div>
              <div className="detail-summary-value">
                {sortedRows[0]?.totalPortfolio
                  ? `${fmtPct.format(
                      (data.total / sortedRows.reduce((s, r) => s + (r.totalPortfolio ?? 0), 0)) * 100,
                    )} %`
                  : "—"}
              </div>
              <div className="detail-summary-sub">% de l&apos;encours total</div>
            </div>
          )}
        </div>

        {/* ── Graphique ── */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Visualisation</div>
              <div className="panel-title">{label} — Distribution par agence</div>
            </div>
          </div>
          <div className="panel-body">
            <div style={{ height: Math.max(280, sortedRows.length * 42 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={sortedRows}
                  layout="vertical"
                  margin={{ left: 12, right: 40, top: 4, bottom: 4 }}
                >
                  <CartesianGrid stroke="rgba(122,31,43,0.10)" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={v => formatCompact(Number(v), unit)}
                    tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                    axisLine={false} tickLine={false}
                  />
                  <YAxis
                    dataKey="agencyName"
                    type="category"
                    width={150}
                    tick={{ fill: "#5d4349", fontSize: 12, fontWeight: 700 }}
                    axisLine={false} tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--surface-4)",
                      border: "1px solid var(--border-md)",
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                    formatter={(value: ValueType | undefined) => [
                      formatValue(toNumber(value), unit),
                      label,
                    ]}
                    labelFormatter={(labelValue) => {
                      const agencyName = String(labelValue ?? "");
                      const row = sortedRows.find(r => r.agencyName === agencyName);
                      return row ? `${row.agencyName} — ${row.agencyCode}` : agencyName;
                    }}
                  />
                  <Bar dataKey="valeur" radius={[0, 6, 6, 0]} label={false}>
                    {sortedRows.map((entry, i) => (
                      <Cell
                        key={entry.agencyCode}
                        fill={barFill(indicator, i, sortedRows.length)}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* ── Graphique tendance (adhesions uniquement) ── */}
        {indicator === "adhesions" && data.trend && data.trend.length > 0 && (
          <div className="panel">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">Évolution</div>
                <div className="panel-title">Nouvelles adhésions — 12 derniers mois</div>
              </div>
              <div className="detail-total-badge">
                Total période : <strong>{fmtInt.format(data.trend.reduce((s, t) => s + t.total, 0))}</strong>
              </div>
            </div>
            <div className="panel-body">
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.trend} margin={{ left: 0, right: 12, top: 4, bottom: 4 }}>
                    <defs>
                      <linearGradient id="gradAdhDetail" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="var(--teal)" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="var(--teal)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tickFormatter={shortMonth}
                      tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                      axisLine={false} tickLine={false}
                    />
                    <YAxis
                      tickFormatter={v => fmtInt.format(Number(v))}
                      tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                      axisLine={false} tickLine={false} width={52}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface-4)",
                        border: "1px solid var(--border-md)",
                        borderRadius: 10,
                        fontSize: 12,
                      }}
                      formatter={(value: ValueType | undefined) => [
                        fmtInt.format(toNumber(value)),
                        "Nouvelles adhésions",
                      ]}
                      labelFormatter={(l) => shortMonth(String(l))}
                    />
                    <Area
                      type="monotone" dataKey="total"
                      stroke="var(--teal)" strokeWidth={2.5}
                      fill="url(#gradAdhDetail)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* ── Table détaillée ── */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Détail</div>
              <div className="panel-title">Classement complet des mutuelles</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                className="refresh-btn"
                title="Exporter en Excel"
                onClick={() => exportDetailToExcel({
                  indicator,
                  label,
                  unit,
                  hasRate: data.hasRate,
                  total: data.total,
                  rows: sortedRows,
                  objectifGlobal,
                  lowerIsBetter,
                  appName: branding.appName || "STATIS",
                })}
              >
                📥 Excel
              </button>
              <div className="detail-total-badge">
                Total : <strong>{formatValue(data.total, unit)}</strong>
              </div>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Rang</th>
                  <th>Mutuelle / Agence</th>
                  <th>Code</th>
                  <th style={{ textAlign: "right" }}>{label}</th>
                  {showInOutColumns && <th style={{ textAlign: "right" }}>{inColumnLabel}</th>}
                  {showInOutColumns && <th style={{ textAlign: "right" }}>{outColumnLabel}</th>}
                  {indicator === "adhesions" && <th style={{ textAlign: "right" }}>Stock total</th>}
                  {data.hasRate && <th style={{ textAlign: "right" }}>Taux PAR</th>}
                  {sortedRows[0]?.count !== undefined && indicator !== "adhesions" && <th style={{ textAlign: "right" }}>{countColumnLabel}</th>}
                  <th style={{ textAlign: "right" }}>Part du total</th>
                  {hasObjectifs && <th style={{ textAlign: "right", minWidth: 160 }}>🎯 Vs Objectif</th>}
                  <th style={{ width: 140 }}>Répartition</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, i) => {
                  const share = data.total > 0 ? (row.valeur / data.total) * 100 : 0;
                  const barPct = maxValeur > 0 ? (row.valeur / maxValeur) * 100 : 0;
                  // Per-agency objective: use agency-specific if available, fall back to global
                  const agObjRaw = row.objectif ?? objectifAgence[row.agencyCode] ?? objectifGlobal;
                  const agencyDrilldownHref = agencyDrilldownLabel
                    ? detailHref(`/detail/${indicator}/${encodeURIComponent(row.agencyCode)}`)
                    : null;
                  return (
                    <tr key={row.agencyCode}>
                      <td>
                        <span className={`rank-chip${i < 3 ? ` top-${i + 1}` : ""}`}>{i + 1}</span>
                      </td>
                      <td>
                        {agencyDrilldownHref ? (
                          <Link
                            href={agencyDrilldownHref}
                            className="detail-drill-link"
                            title={`Voir le detail de ${row.agencyName}`}
                          >
                            <span className="detail-agency-name">{row.agencyName}</span>
                            <span className="detail-drill-sub">{agencyDrilldownLabel}</span>
                          </Link>
                        ) : (
                          <span className="detail-agency-name">{row.agencyName}</span>
                        )}
                      </td>
                      <td>
                        <span className="detail-agency-code">{row.agencyCode}</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span className="td-amount">{formatValue(row.valeur, unit)}</span>
                      </td>
                      {showInOutColumns && (
                        <td className="td-num" style={{ textAlign: "right", color: "var(--objective-green)", fontWeight: 800 }}>
                          {formatValue(row.cashInAmount ?? 0, unit)}
                        </td>
                      )}
                      {showInOutColumns && (
                        <td className="td-num" style={{ textAlign: "right", color: "var(--red)", fontWeight: 800 }}>
                          {formatValue(row.cashOutAmount ?? 0, unit)}
                        </td>
                      )}
                      {indicator === "adhesions" && (
                        <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                          {fmtInt.format(row.totalStock ?? 0)}
                        </td>
                      )}
                      {data.hasRate && (
                        <td className="td-num" style={{ textAlign: "right" }}>
                          <span style={{
                            color: (row.rate ?? 0) < 3 ? "var(--green)"
                              : (row.rate ?? 0) < 8  ? "var(--amber)"
                              : "var(--red)",
                            fontWeight: 600,
                          }}>
                            {fmtPct.format(row.rate ?? 0)} %
                          </span>
                        </td>
                      )}
                      {row.count !== undefined && indicator !== "adhesions" && (
                        <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                          {fmtInt.format(row.count)}
                        </td>
                      )}
                      <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                        {fmtPct.format(share)} %
                      </td>
                      {hasObjectifs && (
                        agObjRaw !== null && agObjRaw !== undefined ? (
                          <ObjAchievementCell
                            actual={row.valeur}
                            objectif={agObjRaw}
                            unit={unit}
                            lowerIsBetter={lowerIsBetter}
                          />
                        ) : (
                          <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)", fontSize: "0.7rem" }}>
                            —
                          </td>
                        )
                      )}
                      <td>
                        <div className="detail-minibar-track">
                          <div
                            className="detail-minibar-fill"
                            style={{
                              width: `${barPct}%`,
                              background: barFill(indicator, i, sortedRows.length),
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      <footer className="app-footer">
        <Link href={detailHref("/")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          ← Retour au tableau de bord
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO · Détail {label}</span>
        <span className="footer-dot" />
        <span>Données SQL Server <code>localhost\SQL2022</code></span>
      </footer>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Utilitaire : slug → label lisible si API indisponible
══════════════════════════════════════════════════════════════ */
function decodeIndicator(slug: string): string {
  const map: Record<string, string> = {
    "adhesions":             "Adhésions",
    "encours-credit":        "Encours Crédit",
    "encours-epargne":       "Encours Épargne",
    "par-1j":                "PAR à 1 Jour",
    "par-30j":               "PAR à 30 Jours",
    "par-90j":               "PAR à 90 Jours",
    "resultat":              "Résultat",
    "tontine-collecte":      "Collecte Tontine",
    "decaissements":         "Décaissements",
    "impayes":               "Impayés",
    "stock-perte":           "Stock Crédit en Perte",
    "transfere-perte":       "Transféré en Perte",
    "recouvrement":          "Recouvrement",
    "mobile-money":          "Mobile Money",
    "tresorerie":            "Trésorerie",
    "souscriptions-tontine": "Souscriptions Tontine",
  };
  return map[slug] ?? slug;
}
