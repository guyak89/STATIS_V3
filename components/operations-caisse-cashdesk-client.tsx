"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useBranding } from "@/components/app-branding";
import { exportOperationsCaisseDeskToExcel } from "@/lib/excel-export";
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

type CashDirection = "IN" | "OUT";

type CashCategoryRow = {
  categoryCode: string;
  categoryLabel: string;
  direction: CashDirection;
  valeur: number;
  cashInAmount: number;
  cashOutAmount: number;
  operations: number;
};

type CashDeskPayload = {
  indicator: "operations-caisse";
  label: string;
  unit: "currency";
  level: "category";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  cashDeskKey: string;
  cashDeskCode: string;
  cashDeskLabel: string;
  cashDeskAccount: string;
  total: number;
  cashInAmount: number;
  cashOutAmount: number;
  previousBalance: number;
  calculatedBalance: number;
  operations: number;
  rows: CashCategoryRow[];
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

const fetcher = async (url: string): Promise<CashDeskPayload> => {
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

function barFill(row: CashCategoryRow, index: number) {
  const base = row.direction === "IN" ? "22,135,90" : "194,65,59";
  const opacity = Math.max(0.34, 0.92 - index * 0.06);
  return `rgba(${base},${opacity})`;
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

export function OperationsCaisseCashDeskClient({
  agencyCode,
  cashDeskKey,
}: {
  agencyCode: string;
  cashDeskKey: string;
}) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const normalizedCashDeskKey = decodeURIComponent(cashDeskKey).trim();
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/operations-caisse/${encodeURIComponent(normalizedAgencyCode)}/${encodeURIComponent(normalizedCashDeskKey)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const nonZeroRows = (data?.rows ?? []).filter((row) => row.valeur > 0 || row.operations > 0);
  const chartRows = nonZeroRows.length > 0 ? nonZeroRows : data?.rows ?? [];
  const maxValeur = data?.rows.reduce((max, row) => Math.max(max, row.valeur), 0) ?? 1;

  const header = (
    <header className="app-header">
      <Link
        href={detailHref(`/detail/operations-caisse/${encodeURIComponent(normalizedAgencyCode)}`)}
        className="back-btn"
        title="Retour aux caisses"
      >
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">⇅</div>
        <div>
          <div className="brand-name">Types d&apos;opérations par caisse</div>
          <div className="brand-sub">
            {data ? `${data.agencyName} - ${data.cashDeskLabel}` : normalizedCashDeskKey}
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
              <div className="error-title">Erreur lors du chargement des types d&apos;opérations</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">SV</div>
            <div className="detail-summary-label">Solde de veille</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.previousBalance)}</div>
            <div className="detail-summary-sub">{data.cashDeskLabel}</div>
          </div>

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
            <div className="detail-summary-value">{fmtCurrency.format(data.calculatedBalance)}</div>
            <div className="detail-summary-sub">Solde veille + entrées - sorties</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">#</div>
            <div className="detail-summary-label">Nombre d&apos;opérations</div>
            <div className="detail-summary-value">{fmtInt.format(data.operations)}</div>
            <div className="detail-summary-sub">{data.cashDeskLabel}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Type d&apos;opération</div>
              <div className="panel-title">{data.cashDeskLabel} - Dispatch par type</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn-export"
                onClick={() =>
                  exportOperationsCaisseDeskToExcel({
                    agencyCode: normalizedAgencyCode,
                    agencyName: data.agencyName,
                    asOfDate: data.asOfDate,
                    cashDeskCode: data.cashDeskCode,
                    cashDeskLabel: data.cashDeskLabel,
                    cashDeskAccount: data.cashDeskAccount,
                    total: data.total,
                    cashInAmount: data.cashInAmount,
                    cashOutAmount: data.cashOutAmount,
                    previousBalance: data.previousBalance,
                    calculatedBalance: data.calculatedBalance,
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
            <div style={{ height: Math.max(300, chartRows.length * 42 + 50) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartRows}
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
                    dataKey="categoryCode"
                    type="category"
                    width={220}
                    interval={0}
                    tickFormatter={(value) => {
                      const code = String(value ?? "");
                      const row = chartRows.find((item) => item.categoryCode === code);
                      return row ? shortLabel(row.categoryLabel) : code;
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
                      "Montant",
                    ]}
                    labelFormatter={(labelValue) => {
                      const code = String(labelValue ?? "");
                      const row = chartRows.find((item) => item.categoryCode === code);
                      return row ? `${row.categoryLabel} - ${row.direction === "IN" ? "Entrée" : "Sortie"}` : code;
                    }}
                  />
                  <Bar dataKey="valeur" radius={[0, 6, 6, 0]} label={false}>
                    {chartRows.map((row, index) => (
                      <Cell key={`cash-category-${row.categoryCode}`} fill={barFill(row, index)} />
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
                  <th>Type d&apos;opération</th>
                  <th>Direction</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                  <th style={{ textAlign: "right" }}>Nombre d&apos;opérations</th>
                  <th style={{ textAlign: "right" }}>Part</th>
                  <th style={{ width: 140 }}>Répartition</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, index) => {
                  const share = data.total > 0 ? (row.valeur / data.total) * 100 : 0;
                  const barPct = maxValeur > 0 ? (row.valeur / maxValeur) * 100 : 0;
                  const href = detailHref(`/detail/operations-caisse/${encodeURIComponent(data.agencyCode)}/${encodeURIComponent(data.cashDeskKey)}/${encodeURIComponent(row.categoryCode)}`);

                  return (
                    <tr key={row.categoryCode}>
                      <td>
                        <span className={`rank-chip${index < 3 ? ` top-${index + 1}` : ""}`}>
                          {index + 1}
                        </span>
                      </td>
                      <td>
                        <Link href={href} className="detail-drill-link" title={`Voir les opérations ${row.categoryLabel}`}>
                          <span className="detail-agency-name">{row.categoryLabel}</span>
                          <span className="detail-drill-sub">Détail des opérations</span>
                        </Link>
                      </td>
                      <td><DirectionBadge direction={row.direction} /></td>
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
                              background: barFill(row, index),
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
        <Link
          href={detailHref(`/detail/operations-caisse/${encodeURIComponent(data.agencyCode)}`)}
          style={{ color: "var(--teal)", textDecoration: "none" }}
        >
          Retour aux caisses
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>OPERATION</code> / <code>RUBINS</code></span>
      </footer>
    </div>
  );
}
