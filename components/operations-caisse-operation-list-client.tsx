"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useBranding } from "@/components/app-branding";
import { exportOperationsCaisseListToExcel } from "@/lib/excel-export";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";
import type { ReactNode } from "react";

type CashDirection = "IN" | "OUT";

type OperationRow = {
  operationSource: string;
  operationId: string;
  operationNumber: string;
  receiptNumber: string;
  operationCode: string;
  operationLabel: string;
  operationDate: string;
  accountNumber: string;
  accountLabel: string;
  customerCode: string;
  customerName: string;
  userCode: string;
  collectorCode: string;
  collectorName: string;
  description: string;
  chequeNumber: string;
  currencyCode: string;
  amount: number;
  direction: CashDirection;
};

type OperationListPayload = {
  indicator: "operations-caisse";
  label: string;
  unit: "currency";
  level: "operations";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  cashDeskKey: string;
  cashDeskCode: string;
  cashDeskLabel: string;
  cashDeskAccount: string;
  categoryCode: string;
  categoryLabel: string;
  direction: CashDirection;
  total: number;
  cashInAmount: number;
  cashOutAmount: number;
  operations: number;
  rows: OperationRow[];
};

const fmtCurrency = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "XOF",
  maximumFractionDigits: 0,
});
const fmtInt = new Intl.NumberFormat("fr-FR");
const fmtDateTime = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fmtDate = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

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

function DirectionBadge({ direction }: { direction: CashDirection }) {
  const isIn = direction === "IN";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 9px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 900,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: isIn ? "var(--objective-green)" : "var(--red)",
        background: isIn ? "var(--objective-green-soft)" : "var(--red-soft)",
      }}
    >
      <span>{isIn ? "↗" : "↘"}</span>
      {isIn ? "Entrée" : "Sortie"}
    </span>
  );
}

function SecondaryLine({ children }: { children: ReactNode }) {
  return <span style={{ display: "block", color: "var(--text-dim)", fontSize: 11, fontWeight: 650 }}>{children}</span>;
}

export function OperationsCaisseOperationListClient({
  agencyCode,
  cashDeskKey,
  categoryCode,
}: {
  agencyCode: string;
  cashDeskKey: string;
  categoryCode: string;
}) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const normalizedCashDeskKey = decodeURIComponent(cashDeskKey).trim();
  const normalizedCategoryCode = decodeURIComponent(categoryCode).trim();
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/operations-caisse/${encodeURIComponent(normalizedAgencyCode)}/${encodeURIComponent(normalizedCashDeskKey)}/${encodeURIComponent(normalizedCategoryCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const header = (
    <header className="app-header">
      <Link
        href={detailHref(`/detail/operations-caisse/${encodeURIComponent(normalizedAgencyCode)}/${encodeURIComponent(normalizedCashDeskKey)}`)}
        className="back-btn"
        title="Retour aux types"
      >
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">⇅</div>
        <div>
          <div className="brand-name">Détail des opérations</div>
          <div className="brand-sub">
            {data ? `${data.agencyName} - ${data.categoryLabel}` : normalizedCategoryCode}
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
              <div className="error-title">Erreur lors du chargement des opérations</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: data.direction === "IN" ? "var(--objective-green)" : "var(--red)" }}>
            <div className="detail-summary-icon">{data.direction === "IN" ? "↗" : "↘"}</div>
            <div className="detail-summary-label">{data.categoryLabel}</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">Journée du {formatDate(data.asOfDate)}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">#</div>
            <div className="detail-summary-label">Nombre d&apos;opérations</div>
            <div className="detail-summary-value">{fmtInt.format(data.operations)}</div>
            <div className="detail-summary-sub">{data.cashDeskLabel}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">CA</div>
            <div className="detail-summary-label">Caisse</div>
            <div className="detail-summary-value" style={{ fontSize: "1.05rem" }}>{data.cashDeskLabel || "-"}</div>
            <div className="detail-summary-sub">{data.cashDeskAccount || data.cashDeskCode}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">AG</div>
            <div className="detail-summary-label">Agence</div>
            <div className="detail-summary-value" style={{ fontSize: "1.05rem" }}>{data.agencyName}</div>
            <div className="detail-summary-sub">{data.agencyCode}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Lignes d&apos;opérations</div>
              <div className="panel-title">{data.categoryLabel} - {data.cashDeskLabel}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn-export"
                onClick={() =>
                  exportOperationsCaisseListToExcel({
                    agencyCode: normalizedAgencyCode,
                    agencyName: data.agencyName,
                    asOfDate: data.asOfDate,
                    cashDeskCode: data.cashDeskCode,
                    cashDeskLabel: data.cashDeskLabel,
                    cashDeskAccount: data.cashDeskAccount,
                    categoryCode: data.categoryCode,
                    categoryLabel: data.categoryLabel,
                    direction: data.direction,
                    total: data.total,
                    operations: data.operations,
                    rows: data.rows,
                    appName: branding.appName || "STATIS",
                  })
                }
              >
                ⬇ Export Excel
              </button>
              <div className="detail-total-badge">
                Total : <strong>{fmtCurrency.format(data.total)}</strong>
              </div>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Transaction</th>
                  <th>Libellé</th>
                  <th>Compte / Client</th>
                  <th>Utilisateur</th>
                  <th>Direction</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={`${row.operationSource}-${row.operationId}`}>
                    <td>
                      <span className="detail-agency-code">{formatDateTime(row.operationDate)}</span>
                    </td>
                    <td>
                      <div className="collector-name">
                        <strong>{row.operationNumber || row.operationId}</strong>
                        <span>{row.operationSource}{row.receiptNumber ? ` · Reçu ${row.receiptNumber}` : ""}</span>
                      </div>
                    </td>
                    <td>
                      <div className="collector-name" style={{ maxWidth: 420 }}>
                        <strong>{row.operationLabel || row.operationCode}</strong>
                        <span>{row.description || "-"}</span>
                        {row.chequeNumber && <SecondaryLine>Chèque : {row.chequeNumber}</SecondaryLine>}
                      </div>
                    </td>
                    <td>
                      <div className="collector-name" style={{ maxWidth: 340 }}>
                        <strong>{row.accountNumber || "-"}</strong>
                        <span>{row.customerName || row.accountLabel || "-"}</span>
                        {row.customerCode && <SecondaryLine>Adhérent : {row.customerCode}</SecondaryLine>}
                      </div>
                    </td>
                    <td>
                      <div className="collector-name">
                        <strong>{row.userCode || "-"}</strong>
                        {row.collectorCode && <span>{row.collectorCode} {row.collectorName}</span>}
                      </div>
                    </td>
                    <td><DirectionBadge direction={row.direction} /></td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount">{fmtCurrency.format(row.amount)}</span>
                    </td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucune opération pour ce type sur cette caisse.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link
          href={detailHref(`/detail/operations-caisse/${encodeURIComponent(data.agencyCode)}/${encodeURIComponent(data.cashDeskKey)}`)}
          style={{ color: "var(--teal)", textDecoration: "none" }}
        >
          Retour aux types d&apos;opérations
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>OPERATION</code> / <code>RUBINS</code></span>
      </footer>
    </div>
  );
}
