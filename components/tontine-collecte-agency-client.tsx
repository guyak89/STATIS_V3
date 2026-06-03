"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useBranding } from "@/components/app-branding";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";
import { exportTontineCollecteAgencyToExcel } from "@/lib/excel-export";
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

type CollectorRow = {
  collectorCode: string;
  nom: string;
  prenom: string;
  operations: number;
  depotCount: number;
  commissionCount: number;
  annulationCount: number;
  depotAmount: number;
  commissionAmount: number;
  annulationAmount: number;
  valeur: number;
};

type AgencyPayload = {
  indicator: "tontine-collecte";
  label: string;
  unit: "currency";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart: string;
  total: number;
  operations: number;
  rows: CollectorRow[];
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

const fetcher = async (url: string): Promise<AgencyPayload> => {
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

function collectorName(row: CollectorRow) {
  const fullName = `${row.nom} ${row.prenom}`.trim();
  return fullName || "Collecteur non identifie";
}

function chartCollectorLabel(row: CollectorRow) {
  const name = collectorName(row);
  return name.length > 28 ? `${name.slice(0, 27)}...` : name;
}

function barFill(index: number, total: number): string {
  const opacity = Math.max(0.32, 1 - (index / (total || 1)) * 0.55);
  return `rgba(122,31,43,${opacity})`;
}

export function TontineCollecteAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/tontine-collecte/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const rows = data?.rows ?? [];
  const maxValeur = rows[0]?.valeur ?? 1;
  const topCollector = rows[0] ?? null;

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/tontine-collecte")} className="back-btn" title="Retour au detail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">TC</div>
        <div>
          <div className="brand-name">Collecte Tontine par Collecteur</div>
          <div className="brand-sub">
            {data?.agencyCode ?? normalizedAgencyCode} - {data?.agencyName ?? "Chargement"}
          </div>
        </div>
      </div>
      {data && (
        <div className="header-actions" style={{ marginLeft: "auto" }}>
          <button
            className="btn-export"
            onClick={() =>
              exportTontineCollecteAgencyToExcel({
                agencyCode: data.agencyCode,
                agencyName: data.agencyName,
                asOfDate: data.asOfDate,
                monthStart: data.monthStart,
                total: data.total,
                operations: data.operations,
                rows: data.rows,
                appName: branding.appName || "STATIS",
              })
            }
          >
            📥 Excel
          </button>
        </div>
      )}
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
              <div className="error-title">Erreur lors du chargement du dispatch collecteur</div>
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
          <div className="skeleton-panel" style={{ height: 400 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {header}

      <div className="app-content fade-in">
        <div className="detail-summary-row">
          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">TC</div>
            <div className="detail-summary-label">Collecte nette agence</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">
              D + C - A, periode du {formatDate(data.monthStart)} au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">OP</div>
            <div className="detail-summary-label">Operations</div>
            <div className="detail-summary-value">{fmtInt.format(data.operations)}</div>
            <div className="detail-summary-sub">{rows.length} agent(s) collecteur(s)</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
            <div className="detail-summary-icon">AG</div>
            <div className="detail-summary-label">Premier collecteur</div>
            <div className="detail-summary-value" style={{ fontSize: "1.25rem" }}>
              {topCollector ? topCollector.collectorCode : "-"}
            </div>
            <div className="detail-summary-sub">
              {topCollector ? collectorName(topCollector) : "Aucune collecte"}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">AN</div>
            <div className="detail-summary-label">Annulations</div>
            <div className="detail-summary-value">
              {fmtCurrency.format(rows.reduce((sum, row) => sum + row.annulationAmount, 0))}
            </div>
            <div className="detail-summary-sub">
              {fmtInt.format(rows.reduce((sum, row) => sum + row.annulationCount, 0))} operation(s) deduite(s)
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Visualisation</div>
              <div className="panel-title">
                {data.agencyCode} - Repartition de la collecte par agent collecteur
              </div>
            </div>
            <div className="detail-total-badge">
              Total : <strong>{fmtCurrency.format(data.total)}</strong>
            </div>
          </div>
          <div className="panel-body">
            <div style={{ height: Math.max(280, rows.length * 42 + 40) }}>
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
                    dataKey="collectorCode"
                    type="category"
                    width={190}
                    interval={0}
                    tickFormatter={(value) => {
                      const code = String(value ?? "");
                      const row = rows.find((item) => item.collectorCode === code);
                      return row ? chartCollectorLabel(row) : code;
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
                      "Collecte nette",
                    ]}
                    labelFormatter={(labelValue) => {
                      const code = String(labelValue ?? "");
                      const row = rows.find((item) => item.collectorCode === code);
                      return row ? `${collectorName(row)} - ${code}` : code;
                    }}
                  />
                  <Bar dataKey="valeur" radius={[0, 6, 6, 0]} label={false}>
                    {rows.map((row, index) => (
                      <Cell key={row.collectorCode} fill={barFill(index, rows.length)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Detail</div>
              <div className="panel-title">Dispatch complet par agent collecteur</div>
            </div>
            <div className="detail-total-badge">
              Periode : <strong>{formatDate(data.monthStart)} - {formatDate(data.asOfDate)}</strong>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Rang</th>
                  <th>Nom et prenoms</th>
                  <th>Code agent</th>
                  <th style={{ textAlign: "right" }}>Collecte nette</th>
                  <th style={{ textAlign: "right" }}>Depots</th>
                  <th style={{ textAlign: "right" }}>Commissions</th>
                  <th style={{ textAlign: "right" }}>Annulations</th>
                  <th style={{ textAlign: "right" }}>Operations</th>
                  <th style={{ textAlign: "right" }}>Part</th>
                  <th style={{ width: 140 }}>Repartition</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const share = data.total > 0 ? (row.valeur / data.total) * 100 : 0;
                  const barPct = maxValeur > 0 ? (row.valeur / maxValeur) * 100 : 0;

                  return (
                    <tr key={row.collectorCode}>
                      <td>
                        <span className={`rank-chip${index < 3 ? ` top-${index + 1}` : ""}`}>
                          {index + 1}
                        </span>
                      </td>
                      <td>
                        <div className="collector-name">
                          <strong>{collectorName(row)}</strong>
                          <span>Code {row.collectorCode}</span>
                        </div>
                      </td>
                      <td>
                        <span className="collector-op-count">{row.collectorCode}</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span className="td-amount">{fmtCurrency.format(row.valeur)}</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span>{fmtCurrency.format(row.depotAmount)}</span>
                        <span className="collector-op-count">{fmtInt.format(row.depotCount)} op.</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span>{fmtCurrency.format(row.commissionAmount)}</span>
                        <span className="collector-op-count">{fmtInt.format(row.commissionCount)} op.</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span>{fmtCurrency.format(row.annulationAmount)}</span>
                        <span className="collector-op-count">{fmtInt.format(row.annulationCount)} op.</span>
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
                    <td colSpan={10} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucune operation de collecte tontine sur la periode.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link href={detailHref("/detail/tontine-collecte")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au detail collecte tontine
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO - Dispatch collecteur {data.agencyCode}</span>
        <span className="footer-dot" />
        <span>Source : <code>T_OPERATION.CODE_COLLECT</code> / <code>T_COLLECTEUR</code></span>
      </footer>
    </div>
  );
}
