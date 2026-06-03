"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { exportEncoursCreditDossiersToExcel } from "@/lib/excel-export";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type DossierRow = {
  numDossier: string;
  clientName: string;
  montantDecaisse: number;
  dateDecaissement: string;
  currentOutstanding: number;
  joursRetard: number;
  etatPret: string;
  etatLibelle: string;
};

type DossiersPayload = {
  indicator: "encours-credit";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  groupType: "produit" | "gestionnaire";
  groupCode: string;
  groupName: string;
  totalEncours: number;
  totalDecaisse: number;
  dossiersCount: number;
  maxJoursRetard: number;
  dossiers: DossierRow[];
};

const fmtCurrency = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "XOF",
  maximumFractionDigits: 0,
});
const fmtInt = new Intl.NumberFormat("fr-FR");
const fmtPct = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtDate = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const fetcher = async (url: string): Promise<DossiersPayload> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

function formatDate(value: string) {
  if (!value) return "-";
  return fmtDate.format(new Date(`${value}T00:00:00`));
}

function statusColor(row: DossierRow) {
  if (row.joursRetard > 0 || row.etatPret === "SO") return "var(--red)";
  if (row.etatPret === "SD") return "var(--amber)";
  return "var(--green)";
}

function statusFilterColor(code: string) {
  if (code === "En retard" || code === "Souffrant") return "var(--red)";
  if (code === "Solde apres date arret") return "var(--amber)";
  return "var(--green)";
}

export function EncoursCreditDossiersClient({
  agencyCode,
  groupType,
  code,
}: {
  agencyCode: string;
  groupType: string;
  code: string;
}) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const normalizedGroupType = decodeURIComponent(groupType).trim().toLowerCase();
  const normalizedCode = decodeURIComponent(code).trim();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const [statusFilter, setStatusFilter] = useState("all");
  const backHref = detailHref(`/detail/encours-credit/${encodeURIComponent(normalizedAgencyCode)}`);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/encours-credit/${encodeURIComponent(normalizedAgencyCode)}/${encodeURIComponent(normalizedGroupType)}/${encodeURIComponent(normalizedCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );
  const statusOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const row of data?.dossiers ?? []) {
      labels.add(row.etatLibelle);
    }

    const preferredOrder = ["En retard", "Sain", "Souffrant", "Solde apres date arret"];
    const ordered = preferredOrder.filter((label) => labels.has(label));
    const others = Array.from(labels).filter((label) => !preferredOrder.includes(label));

    return [...ordered, ...others];
  }, [data?.dossiers]);
  const filteredDossiers = useMemo(() => {
    const rows = data?.dossiers ?? [];
    if (statusFilter === "all") return rows;
    return rows.filter((row) => row.etatLibelle === statusFilter);
  }, [data?.dossiers, statusFilter]);
  const filteredTotal = filteredDossiers.reduce((sum, row) => sum + row.currentOutstanding, 0);

  const header = (
    <header className="app-header">
      <Link href={backHref} className="back-btn" title="Retour au detail agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">CR</div>
        <div>
          <div className="brand-name">Credits constituant l&apos;encours</div>
          <div className="brand-sub">
            {data
              ? `${data.agencyCode} - ${data.groupType} ${data.groupCode}`
              : `${normalizedAgencyCode} - ${normalizedGroupType} ${normalizedCode}`}
          </div>
        </div>
      </div>
    </header>
  );

  if (error) {
    return (
      <div className="app">
        {header}
        <div className="app-content">
          <div className="panel">
            <div className="error-panel">
              <div className="error-icon">!</div>
              <div className="error-title">Erreur lors du chargement des credits</div>
              <div className="error-detail">{String(error?.message ?? error)}</div>
              <div className="error-code">{String(error?.message ?? error)}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="app">
        {header}
        <div className="app-content">
          <div className="skeleton-grid">
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton-card" />)}
          </div>
          <div className="skeleton-panel" style={{ height: 420 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {header}

      <div className="app-content fade-in">
        <div className="detail-summary-row">
          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">EC</div>
            <div className="detail-summary-label">Encours total</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.totalEncours)}</div>
            <div className="detail-summary-sub">
              Situation au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">DS</div>
            <div className="detail-summary-label">Dossiers</div>
            <div className="detail-summary-value">{fmtInt.format(data.dossiersCount)}</div>
            <div className="detail-summary-sub">
              {data.agencyCode} - {data.agencyName}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
            <div className="detail-summary-icon">MD</div>
            <div className="detail-summary-label">Montant decaisse</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.totalDecaisse)}</div>
            <div className="detail-summary-sub">
              Ratio encours/decaisse : {data.totalDecaisse > 0 ? `${fmtPct.format((data.totalEncours / data.totalDecaisse) * 100)} %` : "-"}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">JR</div>
            <div className="detail-summary-label">Retard maximal</div>
            <div className="detail-summary-value">{fmtInt.format(data.maxJoursRetard)} j</div>
            <div className="detail-summary-sub">
              {data.groupType} : {data.groupName} ({data.groupCode})
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Liste des credits</div>
              <div className="panel-title">
                {data.groupType === "produit" ? "Produit" : "Gestionnaire"} {data.groupName} - {data.groupCode}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn-export"
                onClick={() =>
                  exportEncoursCreditDossiersToExcel({
                    agencyCode: data.agencyCode,
                    agencyName: data.agencyName,
                    asOfDate: data.asOfDate,
                    groupType: data.groupType,
                    groupCode: data.groupCode,
                    groupName: data.groupName,
                    totalEncours: data.totalEncours,
                    totalDecaisse: data.totalDecaisse,
                    dossiersCount: data.dossiersCount,
                    maxJoursRetard: data.maxJoursRetard,
                    dossiers: data.dossiers,
                    appName: "STATIS",
                  })
                }
              >
                ⬇ Export Excel
              </button>
              <div className="detail-total-badge">
                Affiche : <strong>{fmtCurrency.format(filteredTotal)}</strong>
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              padding: "0 20px 16px",
            }}
          >
            <span style={{ color: "var(--text-muted)", fontSize: 12, fontWeight: 800 }}>
              Filtrer par etat :
            </span>
            <button
              type="button"
              className="refresh-btn"
              onClick={() => setStatusFilter("all")}
              style={{
                minHeight: 34,
                background: statusFilter === "all" ? "var(--teal)" : undefined,
                color: statusFilter === "all" ? "white" : undefined,
              }}
            >
              Tous ({fmtInt.format(data.dossiers.length)})
            </button>
            {statusOptions.map((option) => {
              const count = data.dossiers.filter((row) => row.etatLibelle === option).length;
              return (
                <button
                  key={option}
                  type="button"
                  className="refresh-btn"
                  onClick={() => setStatusFilter(option)}
                  style={{
                    minHeight: 34,
                    background: statusFilter === option ? statusFilterColor(option) : undefined,
                    color: statusFilter === option ? "white" : undefined,
                  }}
                >
                  {option} ({fmtInt.format(count)})
                </button>
              );
            })}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Numero dossier</th>
                  <th>Client</th>
                  <th>Date decaissement</th>
                  <th style={{ textAlign: "right" }}>Montant decaisse</th>
                  <th style={{ textAlign: "right" }}>Montant encours</th>
                  <th style={{ textAlign: "right" }}>Jours retard</th>
                  <th>Etat dossier</th>
                </tr>
              </thead>
              <tbody>
                {filteredDossiers.map((row) => (
                  <tr key={row.numDossier}>
                    <td>
                      <span className="detail-agency-code">{row.numDossier}</span>
                    </td>
                    <td>
                      <div className="collector-name">
                        <strong>{row.clientName || "Client non identifie"}</strong>
                        <span>{row.numDossier}</span>
                      </div>
                    </td>
                    <td style={{ color: "var(--text-muted)", fontWeight: 700 }}>
                      {formatDate(row.dateDecaissement)}
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                      {fmtCurrency.format(row.montantDecaisse)}
                    </td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount">{fmtCurrency.format(row.currentOutstanding)}</span>
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: row.joursRetard > 0 ? "var(--red)" : "var(--text-muted)", fontWeight: 800 }}>
                      {fmtInt.format(row.joursRetard)}
                    </td>
                    <td>
                      <span style={{ color: statusColor(row), fontWeight: 800 }}>
                        {row.etatLibelle}
                      </span>
                    </td>
                  </tr>
                ))}
                {filteredDossiers.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucun dossier pour cet etat.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link href={backHref} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour a l&apos;encours de {data.agencyName}
        </Link>
      </footer>
    </div>
  );
}
