"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useBranding } from "@/components/app-branding";
import { exportOperationsCaisseAgencyToExcel } from "@/lib/excel-export";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ValueType } from "recharts/types/component/DefaultTooltipContent";

type CashDeskRow = {
  cashDeskKey: string;
  cashDeskCode: string;
  cashDeskLabel: string;
  cashDeskAccount: string;
  valeur: number;
  cashInAmount: number;
  cashOutAmount: number;
  operations: number;
};

type CashAgencyPayload = {
  indicator: "operations-caisse";
  label: string;
  unit: "currency";
  level: "cashdesk";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  total: number;
  cashInAmount: number;
  cashOutAmount: number;
  operations: number;
  rows: CashDeskRow[];
};

const fmtCurrency = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "XOF",
  maximumFractionDigits: 0,
});
const fmtCompact = new Intl.NumberFormat("fr-FR", {
  notation: "compact",
  maximumFractionDigits: 1,
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

const fetcher = async (url: string): Promise<CashAgencyPayload> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

function toNumber(value: ValueType | null | undefined) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function formatDate(value: string) {
  if (!value) return "-";
  return fmtDate.format(new Date(`${value}T00:00:00`));
}

function shortLabel(value: string) {
  return value.length > 30 ? `${value.slice(0, 29)}...` : value;
}

function barFill(index: number) {
  const opacity = Math.max(0.34, 0.92 - index * 0.06);
  return `rgba(122,31,43,${opacity})`;
}

export function OperationsCaisseAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/operations-caisse/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const chartRows = data?.rows.filter((row) => row.valeur > 0 || row.operations > 0) ?? [];
  const displayedChartRows = chartRows.length > 0 ? chartRows : data?.rows ?? [];
  const maxValeur = data?.rows.reduce((max, row) => Math.max(max, row.valeur), 0) ?? 1;

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/operations-caisse")} className="back-btn" title="Retour au détail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">⇅</div>
        <div>
          <div className="brand-name">Opérations de caisse par caisse</div>
          <div className="brand-sub">
            {data?.agencyName ?? "Chargement"}
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
              <div className="error-title">Erreur lors du chargement du détail caisse</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: "var(--objective-green)" }}>
            <div className="detail-summary-icon">↗</div>
            <div className="detail-summary-label">Entrées</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.cashInAmount)}</div>
            <div className="detail-summary-sub">Journée du {formatDate(data.asOfDate)}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--red)" }}>
            <div className="detail-summary-icon">↘</div>
            <div className="detail-summary-label">Sorties</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.cashOutAmount)}</div>
            <div className="detail-summary-sub">Journée du {formatDate(data.asOfDate)}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">⇅</div>
            <div className="detail-summary-label">Mouvement total</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">Entrées + sorties</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">#</div>
            <div className="detail-summary-label">Nombre d&apos;opérations</div>
            <div className="detail-summary-value">{fmtInt.format(data.operations)}</div>
            <div className="detail-summary-sub">Toutes caisses de l&apos;agence</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Caisse</div>
              <div className="panel-title">{data.agencyName} - Répartition des opérations par caisse</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn-export"
                onClick={() =>
                  exportOperationsCaisseAgencyToExcel({
                    agencyCode: normalizedAgencyCode,
                    agencyName: data.agencyName,
                    asOfDate: data.asOfDate,
                    total: data.total,
                    cashInAmount: data.cashInAmount,
                    cashOutAmount: data.cashOutAmount,
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
          <div className="panel-body">
            <div style={{ height: Math.max(300, displayedChartRows.length * 42 + 50) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={displayedChartRows}
                  layout="vertical"
                  margin={{ left: 12, right: 40, top: 4, bottom: 4 }}
                >
                  <CartesianGrid stroke="rgba(122,31,43,0.10)" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={(value) => `${fmtCompact.format(Number(value))} XOF`}
                    tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    dataKey="cashDeskKey"
                    type="category"
                    width={220}
                    interval={0}
                    tickFormatter={(value) => {
                      const key = String(value ?? "");
                      const row = displayedChartRows.find((item) => item.cashDeskKey === key);
                      return row ? shortLabel(row.cashDeskLabel) : key;
                    }}
                    tick={{ fill: "#5d4349", fontSize: 12, fontWeight: 700 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--surface-4)",
                      border: "1px solid var(--border-md)",
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                    formatter={(value: ValueType | undefined) => [
                      fmtCurrency.format(toNumber(value)),
                      "Mouvement",
                    ]}
                    labelFormatter={(labelValue) => {
                      const key = String(labelValue ?? "");
                      const row = displayedChartRows.find((item) => item.cashDeskKey === key);
                      return row ? `${row.cashDeskLabel} - ${row.cashDeskAccount || row.cashDeskKey}` : key;
                    }}
                  />
                  <Bar dataKey="valeur" radius={[0, 6, 6, 0]} label={false}>
                    {displayedChartRows.map((row, index) => (
                      <Cell key={`cashdesk-${row.cashDeskKey}`} fill={barFill(index)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Rang</th>
                  <th>Caisse</th>
                  <th>Compte caisse</th>
                  <th style={{ textAlign: "right" }}>Entrées</th>
                  <th style={{ textAlign: "right" }}>Sorties</th>
                  <th style={{ textAlign: "right" }}>Mouvement total</th>
                  <th style={{ textAlign: "right" }}>Opérations</th>
                  <th style={{ textAlign: "right" }}>Part</th>
                  <th style={{ width: 140 }}>Répartition</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, index) => {
                  const share = data.total > 0 ? (row.valeur / data.total) * 100 : 0;
                  const barPct = maxValeur > 0 ? (row.valeur / maxValeur) * 100 : 0;
                  const href = detailHref(`/detail/operations-caisse/${encodeURIComponent(data.agencyCode)}/${encodeURIComponent(row.cashDeskKey)}`);

                  return (
                    <tr key={row.cashDeskKey}>
                      <td>
                        <span className={`rank-chip${index < 3 ? ` top-${index + 1}` : ""}`}>
                          {index + 1}
                        </span>
                      </td>
                      <td>
                        <Link href={href} className="detail-drill-link" title={`Voir les types de ${row.cashDeskLabel}`}>
                          <span className="detail-agency-name">{row.cashDeskLabel}</span>
                          <span className="detail-drill-sub">Types d&apos;opérations</span>
                        </Link>
                      </td>
                      <td>
                        <span className="detail-agency-code">
                          {row.cashDeskAccount || row.cashDeskCode || row.cashDeskKey}
                        </span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--objective-green)", fontWeight: 800 }}>
                        {fmtCurrency.format(row.cashInAmount)}
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--red)", fontWeight: 800 }}>
                        {fmtCurrency.format(row.cashOutAmount)}
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
                              background: barFill(index),
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
        <Link href={detailHref("/detail/operations-caisse")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au détail opérations de caisse
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>OPERATION</code> / <code>RUBINS</code></span>
      </footer>
    </div>
  );
}
