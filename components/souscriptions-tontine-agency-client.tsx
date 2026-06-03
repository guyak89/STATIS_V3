"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useBranding } from "@/components/app-branding";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";
import { exportSouscriptionsTontineAgencyToExcel } from "@/lib/excel-export";
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
  subscriptions: number;
};

type AgencyPayload = {
  indicator: "souscriptions-tontine";
  label: string;
  unit: "count";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart: string;
  total: number;
  collectors: number;
  rows: CollectorRow[];
};

const fmtInt = new Intl.NumberFormat("fr-FR");
const fmtCompact = new Intl.NumberFormat("fr-FR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
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
  return name.length > 30 ? `${name.slice(0, 29)}...` : name;
}

function barFill(index: number, total: number): string {
  const opacity = Math.max(0.32, 1 - (index / (total || 1)) * 0.55);
  return `rgba(141,90,143,${opacity})`;
}

export function SouscriptionsTontineAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/souscriptions-tontine/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const rows = data?.rows ?? [];
  const maxSubscriptions = rows[0]?.subscriptions ?? 1;
  const topCollector = rows[0] ?? null;
  const average = data && data.collectors > 0 ? data.total / data.collectors : 0;

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/souscriptions-tontine")} className="back-btn" title="Retour au detail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">ST</div>
        <div>
          <div className="brand-name">Souscriptions Tontine par Collecteur</div>
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
              exportSouscriptionsTontineAgencyToExcel({
                agencyCode: data.agencyCode,
                agencyName: data.agencyName,
                asOfDate: data.asOfDate,
                monthStart: data.monthStart,
                total: data.total,
                collectors: data.collectors,
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
              <div className="error-title">Erreur lors du chargement du detail souscriptions tontine</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: "var(--purple)" }}>
            <div className="detail-summary-icon">ST</div>
            <div className="detail-summary-label">Souscriptions agence</div>
            <div className="detail-summary-value">{fmtInt.format(data.total)}</div>
            <div className="detail-summary-sub">
              Periode du {formatDate(data.monthStart)} au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">AG</div>
            <div className="detail-summary-label">Agents collecteurs</div>
            <div className="detail-summary-value">{fmtInt.format(data.collectors)}</div>
            <div className="detail-summary-sub">Avec au moins une souscription</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
            <div className="detail-summary-icon">TOP</div>
            <div className="detail-summary-label">Premier agent</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {topCollector ? fmtInt.format(topCollector.subscriptions) : "-"}
            </div>
            <div className="detail-summary-sub">
              {topCollector ? collectorName(topCollector) : "Aucune souscription"}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">MOY</div>
            <div className="detail-summary-label">Moyenne par agent</div>
            <div className="detail-summary-value">{fmtInt.format(Math.round(average))}</div>
            <div className="detail-summary-sub">Souscriptions / agent actif</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Visualisation</div>
              <div className="panel-title">
                {data.agencyCode} - Repartition des souscriptions par agent collecteur
              </div>
            </div>
            <div className="detail-total-badge">
              Total : <strong>{fmtInt.format(data.total)}</strong>
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
                    tickFormatter={(value) => fmtCompact.format(Number(value))}
                    tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    dataKey="collectorCode"
                    type="category"
                    width={220}
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
                      fmtInt.format(toNumber(value)),
                      "Souscriptions",
                    ]}
                    labelFormatter={(labelValue) => {
                      const code = String(labelValue ?? "");
                      const row = rows.find((item) => item.collectorCode === code);
                      return row ? `${collectorName(row)} - ${code}` : code;
                    }}
                  />
                  <Bar dataKey="subscriptions" radius={[0, 6, 6, 0]} label={false}>
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
                  <th style={{ textAlign: "right" }}>Souscriptions</th>
                  <th style={{ textAlign: "right" }}>Part</th>
                  <th style={{ width: 140 }}>Repartition</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const share = data.total > 0 ? (row.subscriptions / data.total) * 100 : 0;
                  const barPct = maxSubscriptions > 0 ? (row.subscriptions / maxSubscriptions) * 100 : 0;

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
                        <span className="td-amount">{fmtInt.format(row.subscriptions)}</span>
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
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucune souscription tontine sur la periode.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link href={detailHref("/detail/souscriptions-tontine")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au detail souscriptions tontine
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO - Dispatch collecteur {data.agencyCode}</span>
        <span className="footer-dot" />
        <span>Source : <code>T_ADHERENT.CODE_COLLECT_ADHE</code> / <code>T_COLLECTEUR</code></span>
      </footer>
    </div>
  );
}
