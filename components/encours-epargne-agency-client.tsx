"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useBranding } from "@/components/app-branding";
import { exportEncoursEpargneAgencyToExcel } from "@/lib/excel-export";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ValueType } from "recharts/types/component/DefaultTooltipContent";

type ProductRow = {
  productKey: string;
  familyCode: string;
  familyName: string;
  productCode: string;
  productName: string;
  valeur: number;
  accounts: number;
  averageBalance: number;
};

type TrendRow = {
  label: string;
  date: string;
  valeur: number;
};

type EncoursEpargneAgencyPayload = {
  indicator: "encours-epargne";
  label: string;
  unit: "currency";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  total: number;
  accounts: number;
  averageBalance: number;
  productRows: ProductRow[];
  trendRows: TrendRow[];
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

const fetcher = async (url: string): Promise<EncoursEpargneAgencyPayload> => {
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

function chartLabel(row: ProductRow) {
  return row.productName.length > 30 ? `${row.productName.slice(0, 29)}...` : row.productName;
}

function barFill(index: number, total: number): string {
  const opacity = Math.max(0.34, 1 - (index / (total || 1)) * 0.55);
  return `rgba(168,50,70,${opacity})`;
}

export function EncoursEpargneAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/encours-epargne/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { refreshInterval: 600000 },
  );

  if (isLoading) {
    return (
      <div className="app-shell">
        <main className="app-main">
          <div className="loading-state">Chargement du detail epargne...</div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-shell">
        <main className="app-main">
          <div className="error-state">
            <strong>Erreur lors du chargement du detail epargne</strong>
            <span>{error instanceof Error ? error.message : "Erreur inconnue"}</span>
          </div>
        </main>
      </div>
    );
  }

  if (!data) return null;

  const rows = [...data.productRows].sort((a, b) => b.valeur - a.valeur);
  const trendRows = [...(data.trendRows ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const maxValeur = rows[0]?.valeur ?? 1;

  return (
    <div className="app-shell">
      <main className="app-main">
        <div className="topbar">
          <div>
            <p className="eyebrow">STATIS - {branding.appName}</p>
            <h1>Encours epargne par produit</h1>
            <p className="muted">
              {data.agencyName} - Situation au {formatDate(data.asOfDate)}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn-export"
              onClick={() =>
                exportEncoursEpargneAgencyToExcel({
                  agencyCode: normalizedAgencyCode,
                  agencyName: data.agencyName,
                  asOfDate: data.asOfDate,
                  total: data.total,
                  accounts: data.accounts,
                  averageBalance: data.averageBalance,
                  productRows: data.productRows,
                  appName: branding.appName || "STATIS",
                })
              }
            >
              ⬇ Export Excel
            </button>
            <Link href={detailHref("/detail/encours-epargne")} className="btn-secondary">
              Retour aux mutuelles
            </Link>
          </div>
        </div>

        <div className="app-content fade-in">
          <div className="detail-summary-row">
            <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
              <div className="detail-summary-icon">💰</div>
              <div className="detail-summary-label">Encours total</div>
              <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
              <div className="detail-summary-sub">{data.agencyName}</div>
            </div>

            <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
              <div className="detail-summary-icon">#</div>
              <div className="detail-summary-label">Comptes actifs</div>
              <div className="detail-summary-value">{fmtInt.format(data.accounts)}</div>
              <div className="detail-summary-sub">EPG, DAT et tontine</div>
            </div>

            <div className="detail-summary-card" style={{ borderTopColor: "var(--purple)" }}>
              <div className="detail-summary-icon">Ø</div>
              <div className="detail-summary-label">Solde moyen</div>
              <div className="detail-summary-value">{fmtCurrency.format(data.averageBalance)}</div>
              <div className="detail-summary-sub">Par compte actif</div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">Evolution mensuelle</div>
                <div className="panel-title">Encours epargne en fin de mois</div>
              </div>
              <div className="detail-total-badge">
                Dernier point : <strong>{fmtCurrency.format(trendRows.at(-1)?.valeur ?? data.total)}</strong>
              </div>
            </div>
            <div className="panel-body">
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={trendRows}
                    margin={{ left: 12, right: 28, top: 12, bottom: 4 }}
                  >
                    <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#73585e", fontSize: 11, fontWeight: 700 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={(value) => `${fmtCompact.format(Number(value))} XOF`}
                      tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                      axisLine={false}
                      tickLine={false}
                      width={92}
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
                        "Encours fin de mois",
                      ]}
                      labelFormatter={(labelValue) => {
                        const row = trendRows.find((item) => item.label === String(labelValue ?? ""));
                        return row ? `${row.label} - ${formatDate(row.date)}` : String(labelValue ?? "");
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="valeur"
                      stroke="var(--red)"
                      strokeWidth={3}
                      dot={{ r: 4, fill: "var(--red)", strokeWidth: 2, stroke: "var(--surface-1)" }}
                      activeDot={{ r: 6, fill: "var(--red)" }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">Produit d&apos;epargne</div>
                <div className="panel-title">Repartition de l&apos;encours par produit</div>
              </div>
              <div className="detail-total-badge">
                Total : <strong>{fmtCurrency.format(data.total)}</strong>
              </div>
            </div>
            <div className="panel-body">
              <div style={{ height: Math.max(280, rows.length * 44 + 40) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={rows}
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
                      dataKey="productKey"
                      type="category"
                      width={230}
                      interval={0}
                      tickFormatter={(value) => {
                        const key = String(value ?? "");
                        const row = rows.find((item) => item.productKey === key);
                        return row ? chartLabel(row) : key;
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
                        "Encours",
                      ]}
                      labelFormatter={(labelValue) => {
                        const key = String(labelValue ?? "");
                        const row = rows.find((item) => item.productKey === key);
                        return row ? `${row.productName} - ${row.familyName}` : key;
                      }}
                    />
                    <Bar dataKey="valeur" radius={[0, 6, 6, 0]} label={false}>
                      {rows.map((row, index) => (
                        <Cell key={row.productKey} fill={barFill(index, rows.length)} />
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
                    <th>Famille</th>
                    <th>Produit</th>
                    <th style={{ textAlign: "right" }}>Encours</th>
                    <th style={{ textAlign: "right" }}>Comptes</th>
                    <th style={{ textAlign: "right" }}>Solde moyen</th>
                    <th style={{ textAlign: "right" }}>Part</th>
                    <th style={{ width: 140 }}>Repartition</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const share = data.total !== 0 ? (row.valeur / data.total) * 100 : 0;
                    const barPct = maxValeur !== 0 ? Math.abs(row.valeur / maxValeur) * 100 : 0;

                    return (
                      <tr key={row.productKey}>
                        <td>
                          <span className={`rank-chip${index < 3 ? ` top-${index + 1}` : ""}`}>
                            {index + 1}
                          </span>
                        </td>
                        <td>
                          <span className="detail-agency-code">{row.familyName}</span>
                        </td>
                        <td>
                          <div className="collector-name">
                            <strong>{row.productName}</strong>
                            <span>{row.productCode}</span>
                          </div>
                        </td>
                        <td className="td-num" style={{ textAlign: "right" }}>
                          <span className="td-amount">{fmtCurrency.format(row.valeur)}</span>
                        </td>
                        <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                          {fmtInt.format(row.accounts)}
                        </td>
                        <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                          {fmtCurrency.format(row.averageBalance)}
                        </td>
                        <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                          {fmtPct.format(share)} %
                        </td>
                        <td>
                          <div className="detail-minibar-track">
                            <div
                              className="detail-minibar-fill"
                              style={{
                                width: `${Math.min(barPct, 100)}%`,
                                background: barFill(index, rows.length),
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                        Aucun produit d&apos;epargne trouve pour cette mutuelle.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
