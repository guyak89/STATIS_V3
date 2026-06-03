"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useBranding } from "@/components/app-branding";
import { exportEncoursCreditAgencyToExcel } from "@/lib/excel-export";
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

type BreakdownRow = {
  code: string;
  name: string;
  valeur: number;
  dossiers: number;
  averageAmount: number;
  riskOutstanding: number;
  parRate: number;
};

type EncoursCreditPayload = {
  indicator: "encours-credit";
  label: string;
  unit: "currency";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  total: number;
  dossiers: number;
  averageAmount: number;
  riskOutstanding: number;
  parRate: number;
  productRows: BreakdownRow[];
  managerRows: BreakdownRow[];
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

const fetcher = async (url: string): Promise<EncoursCreditPayload> => {
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

function chartLabel(row: BreakdownRow) {
  return row.name.length > 30 ? `${row.name.slice(0, 29)}...` : row.name;
}

function barFill(kind: "product" | "manager", index: number, total: number): string {
  const opacity = Math.max(0.32, 1 - (index / (total || 1)) * 0.55);
  return kind === "product"
    ? `rgba(63,127,164,${opacity})`
    : `rgba(122,31,43,${opacity})`;
}

function DispatchSection({
  agencyCode,
  title,
  kicker,
  rows,
  total,
  kind,
  emptyLabel,
  asOfDate,
}: {
  agencyCode: string;
  title: string;
  kicker: string;
  rows: BreakdownRow[];
  total: number;
  kind: "product" | "manager";
  emptyLabel: string;
  asOfDate: string | null;
}) {
  const maxValeur = rows[0]?.valeur ?? 1;

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker">{kicker}</div>
          <div className="panel-title">{title}</div>
        </div>
        <div className="detail-total-badge">
          Total : <strong>{fmtCurrency.format(total)}</strong>
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
                dataKey="code"
                type="category"
                width={220}
                interval={0}
                tickFormatter={(value) => {
                  const code = String(value ?? "");
                  const row = rows.find((item) => item.code === code);
                  return row ? chartLabel(row) : code;
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
                  "Encours credit",
                ]}
                labelFormatter={(labelValue) => {
                  const code = String(labelValue ?? "");
                  const row = rows.find((item) => item.code === code);
                  return row ? `${row.name} - ${code}` : code;
                }}
              />
              <Bar dataKey="valeur" radius={[0, 6, 6, 0]} label={false}>
                {rows.map((row, index) => (
                  <Cell key={`${kind}-${row.code}`} fill={barFill(kind, index, rows.length)} />
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
              <th>{kind === "product" ? "Produit de credit" : "Gestionnaire"}</th>
              <th>Code</th>
              <th style={{ textAlign: "right" }}>Encours credit</th>
              <th style={{ textAlign: "right" }}>Encours a risque</th>
              <th style={{ textAlign: "right" }}>PAR 1J</th>
              <th style={{ textAlign: "right" }}>Dossiers</th>
              <th style={{ textAlign: "right" }}>Encours moyen</th>
              <th style={{ textAlign: "right" }}>Part</th>
              <th style={{ width: 140 }}>Repartition</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const share = total > 0 ? (row.valeur / total) * 100 : 0;
              const barPct = maxValeur > 0 ? (row.valeur / maxValeur) * 100 : 0;
              const href = withAsOfDate(`/detail/encours-credit/${encodeURIComponent(agencyCode)}/${kind === "product" ? "produit" : "gestionnaire"}/${encodeURIComponent(row.code)}`, asOfDate);

              return (
                <tr key={`${kind}-row-${row.code}`}>
                  <td>
                    <span className={`rank-chip${index < 3 ? ` top-${index + 1}` : ""}`}>
                      {index + 1}
                    </span>
                  </td>
                  <td>
                    <Link
                      href={href}
                      className="detail-drill-link"
                      title={`Voir les credits de ${row.name}`}
                    >
                      <span className="collector-name">
                        <strong>{row.name}</strong>
                        <span>Code {row.code}</span>
                      </span>
                      <span className="detail-drill-sub">
                        Liste des credits - {kind === "product" ? "Produit de credit" : "Gestionnaire"}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span className="collector-op-count">{row.code}</span>
                  </td>
                  <td className="td-num" style={{ textAlign: "right" }}>
                    <span className="td-amount">{fmtCurrency.format(row.valeur)}</span>
                  </td>
                  <td className="td-num" style={{ textAlign: "right", color: row.riskOutstanding > 0 ? "var(--red)" : "var(--text-muted)" }}>
                    {fmtCurrency.format(row.riskOutstanding)}
                  </td>
                  <td className="td-num" style={{ textAlign: "right" }}>
                    <span style={{
                      color: row.parRate >= 10 ? "var(--red)" : row.parRate >= 3 ? "var(--amber)" : "var(--green)",
                      fontWeight: 900,
                    }}>
                      {fmtPct.format(row.parRate)} %
                    </span>
                  </td>
                  <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                    {fmtInt.format(row.dossiers)}
                  </td>
                  <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                    {fmtCurrency.format(row.averageAmount)}
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
                          background: barFill(kind, index, rows.length),
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
                  {emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EncoursCreditAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const branding = useBranding();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/encours-credit/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const topProduct = data?.productRows[0] ?? null;
  const topManager = data?.managerRows[0] ?? null;
  const globalParColor = (data?.parRate ?? 0) >= 10
    ? "var(--red)"
    : (data?.parRate ?? 0) >= 3
    ? "var(--amber)"
    : "var(--green)";

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/encours-credit")} className="back-btn" title="Retour au detail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">EC</div>
        <div>
          <div className="brand-name">Encours Credit par Agence</div>
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
              exportEncoursCreditAgencyToExcel({
                agencyCode: data.agencyCode,
                agencyName: data.agencyName,
                asOfDate: data.asOfDate,
                total: data.total,
                dossiers: data.dossiers,
                averageAmount: data.averageAmount,
                parRate: data.parRate,
                riskOutstanding: data.riskOutstanding,
                productRows: data.productRows,
                managerRows: data.managerRows,
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
              <div className="error-title">Erreur lors du chargement du detail encours credit</div>
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
        <div className="detail-summary-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">EC</div>
            <div className="detail-summary-label">Encours credit</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">
              Situation au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: globalParColor }}>
            <div className="detail-summary-icon">PAR</div>
            <div className="detail-summary-label">PAR 1J global</div>
            <div className="detail-summary-value" style={{ color: globalParColor }}>
              {fmtPct.format(data.parRate)} %
            </div>
            <div className="detail-summary-sub">
              Encours a risque : {fmtCurrency.format(data.riskOutstanding)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">DS</div>
            <div className="detail-summary-label">Dossiers</div>
            <div className="detail-summary-value">{fmtInt.format(data.dossiers)}</div>
            <div className="detail-summary-sub">
              Encours moyen : {fmtCurrency.format(data.averageAmount)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
            <div className="detail-summary-icon">PR</div>
            <div className="detail-summary-label">Premier produit</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {topProduct ? topProduct.code : "-"}
            </div>
            <div className="detail-summary-sub">
              {topProduct ? topProduct.name : "Aucun encours"}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">GE</div>
            <div className="detail-summary-label">Premier gestionnaire</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {topManager ? topManager.code : "-"}
            </div>
            <div className="detail-summary-sub">
              {topManager ? topManager.name : "Aucun gestionnaire"}
            </div>
          </div>
        </div>

        <DispatchSection
          agencyCode={data.agencyCode}
          title={`${data.agencyCode} - Encours par produit de credit`}
          kicker="Produit"
          rows={data.productRows}
          total={data.total}
          kind="product"
          emptyLabel="Aucun encours par produit pour cette agence."
          asOfDate={asOfDate}
        />

        <DispatchSection
          agencyCode={data.agencyCode}
          title={`${data.agencyCode} - Encours par gestionnaire`}
          kicker="Gestionnaire"
          rows={data.managerRows}
          total={data.total}
          kind="manager"
          emptyLabel="Aucun encours par gestionnaire pour cette agence."
          asOfDate={asOfDate}
        />
      </div>

      <footer className="app-footer">
        <Link href={detailHref("/detail/encours-credit")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au detail encours credit
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO - Detail encours credit {data.agencyCode}</span>
        <span className="footer-dot" />
        <span>Source : <code>PRETS</code> / <code>DEMPRET</code> / <code>PRDT_CRD</code> / <code>GESTIONNAIRE</code></span>
      </footer>
    </div>
  );
}
