"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type CategoryRow = {
  categoryCode: string;
  categoryLabel: string;
  direction: string;
  valeur: number;
  depositAmount: number;
  withdrawalAmount: number;
  operations: number;
};

type MobileMoneyAgencyPayload = {
  indicator: "mobile-money";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  total: number;
  depositAmount: number;
  withdrawalAmount: number;
  operations: number;
  rows: CategoryRow[];
};

const fmtCurrency = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "XOF", maximumFractionDigits: 0 });
const fmtInt = new Intl.NumberFormat("fr-FR");
const fmtPct = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

const fetcher = async (url: string): Promise<MobileMoneyAgencyPayload> => {
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

export function MobileMoneyAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/mobile-money/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const maxValeur = data?.rows.reduce((max, row) => Math.max(max, row.valeur), 0) ?? 1;

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/mobile-money")} className="back-btn" title="Retour au detail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">MM</div>
        <div>
          <div className="brand-name">Mobile Money par Rubrique</div>
          <div className="brand-sub">{data?.agencyName ?? normalizedAgencyCode}</div>
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
              <div className="error-title">Erreur lors du chargement Mobile Money</div>
              <div className="error-detail">{String(error?.message ?? error)}</div>
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
            {[0, 1, 2].map((i) => <div key={i} className="skeleton-card" />)}
          </div>
          <div className="skeleton-panel" />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {header}
      <div className="app-content fade-in">
        <div className="detail-summary-row">
          <div className="detail-summary-card" style={{ borderTopColor: "var(--objective-green)" }}>
            <div className="detail-summary-icon">↗</div>
            <div className="detail-summary-label">Depots</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.depositAmount)}</div>
            <div className="detail-summary-sub">Wallet to Bank</div>
          </div>
          <div className="detail-summary-card" style={{ borderTopColor: "var(--red)" }}>
            <div className="detail-summary-icon">↘</div>
            <div className="detail-summary-label">Retraits</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.withdrawalAmount)}</div>
            <div className="detail-summary-sub">Bank to Wallet</div>
          </div>
          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">MM</div>
            <div className="detail-summary-label">Mouvement total</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">Journee du {formatDate(data.asOfDate)}</div>
          </div>
          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">#</div>
            <div className="detail-summary-label">Operations</div>
            <div className="detail-summary-value">{fmtInt.format(data.operations)}</div>
            <div className="detail-summary-sub">{data.agencyCode}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Rubriques</div>
              <div className="panel-title">{data.agencyName} - Depots et retraits Mobile Money</div>
            </div>
            <div className="detail-total-badge">Total : <strong>{fmtCurrency.format(data.total)}</strong></div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Rubrique</th>
                  <th>Direction</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                  <th style={{ textAlign: "right" }}>Operations</th>
                  <th style={{ textAlign: "right" }}>Part</th>
                  <th style={{ width: 140 }}>Repartition</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const href = detailHref(`/detail/mobile-money/${encodeURIComponent(data.agencyCode)}/${encodeURIComponent(row.categoryCode)}`);
                  const share = data.total > 0 ? (row.valeur / data.total) * 100 : 0;
                  const barPct = maxValeur > 0 ? (row.valeur / maxValeur) * 100 : 0;
                  const isIn = row.direction === "IN";
                  return (
                    <tr key={row.categoryCode}>
                      <td>
                        <Link href={href} className="detail-drill-link" title={`Voir les lignes ${row.categoryLabel}`}>
                          <span className="detail-agency-name">{isIn ? "Depots" : "Retraits"}</span>
                          <span className="detail-drill-sub">{row.categoryLabel}</span>
                        </Link>
                      </td>
                      <td style={{ color: isIn ? "var(--objective-green)" : "var(--red)", fontWeight: 900 }}>
                        {isIn ? "Wallet to Bank" : "Bank to Wallet"}
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span className="td-amount">{fmtCurrency.format(row.valeur)}</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                        {fmtInt.format(row.operations)}
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                        {fmtPct.format(share)} %
                      </td>
                      <td>
                        <div className="detail-minibar-track">
                          <div
                            className="detail-minibar-fill"
                            style={{
                              width: `${barPct}%`,
                              background: isIn ? "var(--objective-green)" : "var(--red)",
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
        <Link href={detailHref("/detail/mobile-money")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au detail Mobile Money
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>OPERATION</code> / <code>COD_TYP_OPERAT MOD1 MOR1</code></span>
      </footer>
    </div>
  );
}
