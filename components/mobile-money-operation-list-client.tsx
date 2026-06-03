"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type OperationRow = {
  operationId: string;
  operationNumber: string;
  receiptNumber: string;
  operationCode: string;
  operationDate: string;
  accountNumber: string;
  accountLabel: string;
  customerName: string;
  userCode: string;
  description: string;
  chequeNumber: string;
  currencyCode: string;
  cashDeskKey: string;
  cashDeskCode: string;
  amount: number;
  direction: string;
};

type OperationListPayload = {
  indicator: "mobile-money";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  categoryCode: string;
  categoryLabel: string;
  direction: string;
  total: number;
  depositAmount: number;
  withdrawalAmount: number;
  operations: number;
  rows: OperationRow[];
};

const fmtCurrency = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "XOF", maximumFractionDigits: 0 });
const fmtInt = new Intl.NumberFormat("fr-FR");
const fmtDate = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtDateTime = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const fetcher = async (url: string): Promise<OperationListPayload> => {
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

function formatDateTime(value: string) {
  if (!value) return "-";
  return fmtDateTime.format(new Date(value));
}

export function MobileMoneyOperationListClient({
  agencyCode,
  categoryCode,
}: {
  agencyCode: string;
  categoryCode: string;
}) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const normalizedCategoryCode = decodeURIComponent(categoryCode).trim();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const backHref = detailHref(`/detail/mobile-money/${encodeURIComponent(normalizedAgencyCode)}`);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/mobile-money/${encodeURIComponent(normalizedAgencyCode)}/${encodeURIComponent(normalizedCategoryCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const header = (
    <header className="app-header">
      <Link href={backHref} className="back-btn" title="Retour aux rubriques">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">MM</div>
        <div>
          <div className="brand-name">Lignes Mobile Money</div>
          <div className="brand-sub">{data ? `${data.agencyName} - ${data.categoryLabel}` : normalizedCategoryCode}</div>
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
              <div className="error-title">Erreur lors du chargement des lignes Mobile Money</div>
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

  const isDeposit = data.direction === "IN";

  return (
    <div className="app">
      {header}
      <div className="app-content fade-in">
        <div className="detail-summary-row">
          <div className="detail-summary-card" style={{ borderTopColor: isDeposit ? "var(--objective-green)" : "var(--red)" }}>
            <div className="detail-summary-icon">{isDeposit ? "↗" : "↘"}</div>
            <div className="detail-summary-label">{isDeposit ? "Depots" : "Retraits"}</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">{data.categoryLabel}</div>
          </div>
          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">#</div>
            <div className="detail-summary-label">Operations</div>
            <div className="detail-summary-value">{fmtInt.format(data.operations)}</div>
            <div className="detail-summary-sub">Journee du {formatDate(data.asOfDate)}</div>
          </div>
          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">AG</div>
            <div className="detail-summary-label">Agence</div>
            <div className="detail-summary-value" style={{ fontSize: "1.05rem" }}>{data.agencyName}</div>
            <div className="detail-summary-sub">{data.agencyCode}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Liste nominative</div>
              <div className="panel-title">{data.categoryLabel}</div>
            </div>
            <div className="detail-total-badge">Total : <strong>{fmtCurrency.format(data.total)}</strong></div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Transaction</th>
                  <th>Compte / Client</th>
                  <th>Caisse</th>
                  <th>Utilisateur</th>
                  <th>Description</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.operationId}>
                    <td><span className="detail-agency-code">{formatDateTime(row.operationDate)}</span></td>
                    <td>
                      <div className="collector-name">
                        <strong>{row.operationNumber || row.operationId}</strong>
                        <span>{row.operationCode}{row.receiptNumber ? ` · Recu ${row.receiptNumber}` : ""}</span>
                      </div>
                    </td>
                    <td>
                      <div className="collector-name">
                        <strong>{row.accountNumber || "-"}</strong>
                        <span>{row.customerName || row.accountLabel || "-"}</span>
                      </div>
                    </td>
                    <td>{row.cashDeskCode || row.cashDeskKey || "-"}</td>
                    <td>{row.userCode || "-"}</td>
                    <td>{row.description || "-"}</td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount">{fmtCurrency.format(row.amount)}</span>
                    </td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucune operation Mobile Money pour cette rubrique.
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
          Retour aux rubriques Mobile Money
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>OPERATION</code></span>
      </footer>
    </div>
  );
}
