"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useMemo, useState } from "react";
import { useBranding } from "@/components/app-branding";
import { exportImpayesToExcel } from "@/lib/excel-export";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

/* ══════════════════════════════════════════════════════════════════
   TYPES
══════════════════════════════════════════════════════════════════ */
type DossierImpaye = {
  NUM_DOSSIER: string;
  nom: string;
  prenom: string;
  premiereEcheanceImpayee: string;
  derniereEcheanceImpayee: string;
  joursRetard: number;
  nbEcheancesImpayees: number;
  capitalImpaye: number;
  interetImpaye: number;
  epargneImpayee: number;
  commissionImpayee: number;
  totalImpaye: number;
  montantPretInitial: number;
  capitalRestantDu: number;
  etatPret: string;
};

type ImpayesPayload = {
  agenceCode: string;
  agenceNom: string;
  dateArret: string;
  totalDossiers: number;
  totalImpaye: number;
  totalCapital: number;
  totalInteret: number;
  totalRestantDu: number;
  maxJoursRetard: number;
  dossiers: DossierImpaye[];
};

/* ══════════════════════════════════════════════════════════════════
   FORMATTERS
══════════════════════════════════════════════════════════════════ */
const fmtCur  = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "XOF", maximumFractionDigits: 0 });
const fmtInt  = new Intl.NumberFormat("fr-FR");
const fmtDate = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

function cur(v: number) { return fmtCur.format(v ?? 0); }
function d(v: string | null | undefined) {
  if (!v) return "—";
  try { return fmtDate.format(new Date(v)); } catch { return v; }
}

/* ── Couleur selon ancienneté ── */
function retardColor(jours: number): string {
  if (jours <= 30)  return "#7a1f2b";
  if (jours <= 90)  return "#d78b1f";
  if (jours <= 180) return "#c2413b";
  return "#8d5a8f";
}
function retardLabel(jours: number): string {
  if (jours <= 30)  return "< 30 j";
  if (jours <= 90)  return "30–90 j";
  if (jours <= 180) return "90–180 j";
  return "> 180 j";
}

/* ══════════════════════════════════════════════════════════════════
   FETCHER
══════════════════════════════════════════════════════════════════ */
const fetcher = async (url: string): Promise<ImpayesPayload> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

type SortHeaderProps = {
  col: keyof DossierImpaye;
  label: string;
  active: boolean;
  sortAsc: boolean;
  onSort: (col: keyof DossierImpaye) => void;
};

function SortHeader({ col, label, active, sortAsc, onSort }: SortHeaderProps) {
  return (
    <th
      onClick={() => onSort(col)}
      style={{
        cursor: "pointer",
        userSelect: "none",
        color: active ? "var(--teal)" : undefined,
        whiteSpace: "nowrap",
      }}
    >
      {label} {active ? (sortAsc ? "↑" : "↓") : ""}
    </th>
  );
}

/* ══════════════════════════════════════════════════════════════════
   COMPOSANT PRINCIPAL
══════════════════════════════════════════════════════════════════ */
export function ImpayesClient({ agence }: { agence: string }) {
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<keyof DossierImpaye>("joursRetard");
  const [sortAsc, setSortAsc] = useState(false);

  const { data, error, isLoading } = useSWR<ImpayesPayload>(
    detailHref(`/api/rapport/impayes/${agence}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  /* ── Tri + filtre ── */
  const rows = useMemo(() => {
    if (!data?.dossiers) return [];
    let list = [...data.dossiers];

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.NUM_DOSSIER.toLowerCase().includes(q) ||
        r.nom.toLowerCase().includes(q) ||
        r.prenom.toLowerCase().includes(q),
      );
    }

    list.sort((a, b) => {
      const va = a[sortCol] as number | string;
      const vb = b[sortCol] as number | string;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [data, search, sortCol, sortAsc]);

  function handleSort(col: keyof DossierImpaye) {
    if (col === sortCol) setSortAsc(p => !p);
    else { setSortCol(col); setSortAsc(false); }
  }

  /* ── Header ── */
  const header = (
    <header className="app-header">
      <Link href={detailHref("/")} className="back-btn">← Tableau de bord</Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo" style={{ background: "linear-gradient(135deg,var(--red),var(--amber))" }}>⚠️</div>
        <div>
          <div className="brand-name">Dossiers en Impayé — {agence}</div>
          <div className="brand-sub">{data?.agenceNom ?? "…"} · Date d&apos;arrêt : {d(data?.dateArret)}</div>
        </div>
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        {data && (
          <button
            className="refresh-btn"
            title="Exporter en Excel"
            onClick={() => exportImpayesToExcel({
              agenceCode:      data.agenceCode,
              agenceNom:       data.agenceNom,
              dateArret:       data.dateArret ?? "",
              totalDossiers:   data.totalDossiers,
              totalImpaye:     data.totalImpaye,
              totalCapital:    data.totalCapital,
              totalInteret:    data.totalInteret,
              totalRestantDu:  data.totalRestantDu,
              maxJoursRetard:  data.maxJoursRetard,
              dossiers:        data.dossiers,
              appName:         branding.appName || "STATIS",
            })}
          >
            📥 Excel
          </button>
        )}
        <button
          className="refresh-btn"
          onClick={() => window.print()}
          title="Imprimer / Exporter PDF"
        >
          🖨️ Imprimer
        </button>
      </div>
    </header>
  );

  if (error) return (
    <div className="app">{header}
      <div className="app-content">
        <div className="panel"><div className="error-panel">
          <div className="error-icon">⚠️</div>
          <div className="error-title">Erreur de chargement</div>
          <div className="error-code">{String(error?.message ?? error)}</div>
        </div></div>
      </div>
    </div>
  );

  if (isLoading || !data) return (
    <div className="app">{header}
      <div className="app-content">
        <div className="skeleton-grid">{[0,1,2,3].map(i=><div key={i} className="skeleton-card"/>)}</div>
        <div className="skeleton-panel" style={{ height: 500 }} />
      </div>
    </div>
  );

  /* ── Statistiques de synthèse ── */
  const buckets = [
    { label: "≤ 30 j",    count: data.dossiers.filter(r => r.joursRetard <=  30).length, color: "#7a1f2b" },
    { label: "31–90 j",   count: data.dossiers.filter(r => r.joursRetard >  30 && r.joursRetard <=  90).length, color: "#d78b1f" },
    { label: "91–180 j",  count: data.dossiers.filter(r => r.joursRetard >  90 && r.joursRetard <= 180).length, color: "#c2413b" },
    { label: "> 180 j",   count: data.dossiers.filter(r => r.joursRetard > 180).length, color: "#8d5a8f" },
  ];

  return (
    <div className="app">
      {header}
      <div className="app-content fade-in">

        {/* ── Synthèse ── */}
        <div className="detail-summary-row">
          <div className="detail-summary-card" style={{ borderTopColor: "var(--red)" }}>
            <div className="detail-summary-icon">📂</div>
            <div className="detail-summary-label">Dossiers en impayé</div>
            <div className="detail-summary-value" style={{ color: "var(--red)" }}>
              {fmtInt.format(data.totalDossiers)}
            </div>
            <div className="detail-summary-sub">dossiers concernés</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">💸</div>
            <div className="detail-summary-label">Total impayé</div>
            <div className="detail-summary-value" style={{ color: "var(--amber)", fontSize: "1.1rem" }}>
              {cur(data.totalImpaye)}
            </div>
            <div className="detail-summary-sub">
              Capital : {cur(data.totalCapital)} · Intérêts : {cur(data.totalInteret)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">📊</div>
            <div className="detail-summary-label">Capital restant dû</div>
            <div className="detail-summary-value" style={{ fontSize: "1.1rem" }}>
              {cur(data.totalRestantDu)}
            </div>
            <div className="detail-summary-sub">encours total en souffrance</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "#7C3AED" }}>
            <div className="detail-summary-icon">⏰</div>
            <div className="detail-summary-label">Retard maximum</div>
            <div className="detail-summary-value" style={{ color: "#7C3AED" }}>
              {fmtInt.format(data.maxJoursRetard)} j
            </div>
            <div className="detail-summary-sub">jours de retard</div>
          </div>
        </div>

        {/* ── Répartition par ancienneté ── */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Analyse</div>
              <div className="panel-title">Répartition par ancienneté du retard</div>
            </div>
          </div>
          <div className="panel-body" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {buckets.map(b => (
              <div key={b.label} style={{
                flex: "1 1 140px",
                background: "var(--surface-3)",
                borderRadius: 12,
                padding: "16px 20px",
                borderLeft: `4px solid ${b.color}`,
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>
                  {b.label}
                </span>
                <span style={{ fontSize: "1.6rem", fontWeight: 700, color: b.color }}>
                  {b.count}
                </span>
                <span style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>dossier(s)</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Table complète ── */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Détail</div>
              <div className="panel-title">Liste complète des dossiers en impayé</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                {rows.length}/{data.totalDossiers} dossier(s)
              </span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="🔍 Filtrer…"
                style={{
                  background: "var(--surface-3)",
                  border: "1px solid var(--border-md)",
                  borderRadius: 8,
                  padding: "5px 10px",
                  color: "var(--text-1)",
                  fontSize: "0.8rem",
                  width: 180,
                  outline: "none",
                }}
              />
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <SortHeader col="NUM_DOSSIER" label="N° Dossier" active={sortCol === "NUM_DOSSIER"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="nom" label="Emprunteur" active={sortCol === "nom"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="joursRetard" label="Jours retard" active={sortCol === "joursRetard"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="premiereEcheanceImpayee" label="1ère échéance" active={sortCol === "premiereEcheanceImpayee"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="derniereEcheanceImpayee" label="Dernière échéance" active={sortCol === "derniereEcheanceImpayee"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="nbEcheancesImpayees" label="Nb échéances" active={sortCol === "nbEcheancesImpayees"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="totalImpaye" label="Total impayé" active={sortCol === "totalImpaye"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="capitalImpaye" label="Capital" active={sortCol === "capitalImpaye"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="interetImpaye" label="Intérêts" active={sortCol === "interetImpaye"} sortAsc={sortAsc} onSort={handleSort} />
                  <SortHeader col="capitalRestantDu" label="Capital restant dû" active={sortCol === "capitalRestantDu"} sortAsc={sortAsc} onSort={handleSort} />
                  <th>Statut prêt</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const color = retardColor(row.joursRetard);
                  const label = retardLabel(row.joursRetard);
                  return (
                    <tr key={row.NUM_DOSSIER} style={{
                      borderLeft: `3px solid ${color}`,
                    }}>
                      <td style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{i + 1}</td>
                      <td>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--teal)", fontSize: "0.82rem" }}>
                          {row.NUM_DOSSIER}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                          {row.nom} {row.prenom}
                        </span>
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span style={{
                          background: color + "22",
                          color,
                          fontWeight: 700,
                          padding: "2px 10px",
                          borderRadius: 20,
                          fontSize: "0.8rem",
                          display: "inline-block",
                          whiteSpace: "nowrap",
                        }}>
                          {fmtInt.format(row.joursRetard)} j · {label}
                        </span>
                      </td>
                      <td className="td-num" style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                        {d(row.premiereEcheanceImpayee)}
                      </td>
                      <td className="td-num" style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                        {d(row.derniereEcheanceImpayee)}
                      </td>
                      <td className="td-num" style={{ textAlign: "center" }}>
                        {row.nbEcheancesImpayees}
                      </td>
                      <td className="td-num td-amount" style={{ color: "var(--red)", fontWeight: 700 }}>
                        {cur(row.totalImpaye)}
                      </td>
                      <td className="td-num" style={{ color: "var(--text-muted)" }}>
                        {cur(row.capitalImpaye)}
                      </td>
                      <td className="td-num" style={{ color: "var(--text-muted)" }}>
                        {cur(row.interetImpaye)}
                      </td>
                      <td className="td-num">
                        {cur(row.capitalRestantDu)}
                      </td>
                      <td>
                        <span style={{
                          background: row.etatPret === "DC" ? "var(--teal-soft)"
                            : row.etatPret === "SO" ? "var(--amber-soft)"
                            : "var(--red-soft)",
                          color: row.etatPret === "DC" ? "var(--teal)"
                            : row.etatPret === "SO" ? "var(--amber)"
                            : "var(--red)",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 6,
                        }}>
                          {row.etatPret}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              {/* Totaux */}
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--border-md)", fontWeight: 700 }}>
                  <td colSpan={7} style={{ textAlign: "right", paddingRight: 16, color: "var(--text-muted)" }}>
                    TOTAL ({rows.length} dossiers)
                  </td>
                  <td className="td-num" style={{ color: "var(--red)" }}>
                    {cur(rows.reduce((s, r) => s + r.totalImpaye, 0))}
                  </td>
                  <td className="td-num" style={{ color: "var(--text-muted)" }}>
                    {cur(rows.reduce((s, r) => s + r.capitalImpaye, 0))}
                  </td>
                  <td className="td-num" style={{ color: "var(--text-muted)" }}>
                    {cur(rows.reduce((s, r) => s + r.interetImpaye, 0))}
                  </td>
                  <td className="td-num">
                    {cur(rows.reduce((s, r) => s + r.capitalRestantDu, 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

      </div>

      <footer className="app-footer">
        <Link href={detailHref("/")} style={{ color: "var(--teal)", textDecoration: "none" }}>← Tableau de bord</Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO · Rapport Impayés {agence}</span>
        <span className="footer-dot" />
        <span>Date d&apos;arrêt : {d(data.dateArret)}</span>
      </footer>
    </div>
  );
}
