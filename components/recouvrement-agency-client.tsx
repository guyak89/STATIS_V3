"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
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

type ProductRow = {
  code: string;
  name: string;
  valeur: number;
  operations: number;
  dossiers: number;
  averageAmount: number;
};

type RecouvrementPayload = {
  indicator: "recouvrement";
  label: string;
  unit: "currency";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart: string;
  total: number;
  operations: number;
  dossiers: number;
  averageAmount: number;
  productRows: ProductRow[];
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

const fetcher = async (url: string): Promise<RecouvrementPayload> => {
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
  return row.name.length > 32 ? `${row.name.slice(0, 31)}...` : row.name;
}

function barFill(index: number, total: number): string {
  const opacity = Math.max(0.32, 1 - (index / (total || 1)) * 0.55);
  return `rgba(168,50,70,${opacity})`;
}

export function RecouvrementAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/recouvrement/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const topProduct = data?.productRows[0] ?? null;
  const maxValeur = data?.productRows[0]?.valeur ?? 1;

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/recouvrement")} className="back-btn" title="Retour au detail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">RC</div>
        <div>
          <div className="brand-name">Recouvrements par Produit</div>
          <div className="brand-sub">
            {data?.agencyCode ?? normalizedAgencyCode} - {data?.agencyName ?? "Chargement"}
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
              <div className="error-title">Erreur lors du chargement du detail recouvrement</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
            <div className="detail-summary-icon">RC</div>
            <div className="detail-summary-label">Montant recouvre</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">
              Periode du {formatDate(data.monthStart)} au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">OP</div>
            <div className="detail-summary-label">Operations</div>
            <div className="detail-summary-value">{fmtInt.format(data.operations)}</div>
            <div className="detail-summary-sub">
              {fmtInt.format(data.dossiers)} dossier(s) recouvre(s)
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--purple)" }}>
            <div className="detail-summary-icon">PR</div>
            <div className="detail-summary-label">Premier produit</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {topProduct ? topProduct.code : "-"}
            </div>
            <div className="detail-summary-sub">
              {topProduct ? topProduct.name : "Aucun recouvrement"}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">MO</div>
            <div className="detail-summary-label">Montant moyen</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.averageAmount)}</div>
            <div className="detail-summary-sub">Par operation de recouvrement</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Produit de credit</div>
              <div className="panel-title">
                {data.agencyCode} - Repartition des recouvrements par produit
              </div>
            </div>
            <div className="detail-total-badge">
              Total : <strong>{fmtCurrency.format(data.total)}</strong>
            </div>
          </div>
          <div className="panel-body">
            <div style={{ height: Math.max(280, data.productRows.length * 42 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.productRows}
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
                      const row = data.productRows.find((item) => item.code === code);
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
                      "Montant recouvre",
                    ]}
                    labelFormatter={(labelValue) => {
                      const code = String(labelValue ?? "");
                      const row = data.productRows.find((item) => item.code === code);
                      return row ? `${row.name} - ${code}` : code;
                    }}
                  />
                  <Bar dataKey="valeur" radius={[0, 6, 6, 0]} label={false}>
                    {data.productRows.map((row, index) => (
                      <Cell key={`product-${row.code}`} fill={barFill(index, data.productRows.length)} />
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
                  <th>Produit de credit</th>
                  <th>Code</th>
                  <th style={{ textAlign: "right" }}>Montant recouvre</th>
                  <th style={{ textAlign: "right" }}>Dossiers</th>
                  <th style={{ textAlign: "right" }}>Operations</th>
                  <th style={{ textAlign: "right" }}>Montant moyen</th>
                  <th style={{ textAlign: "right" }}>Part</th>
                  <th style={{ width: 140 }}>Repartition</th>
                </tr>
              </thead>
              <tbody>
                {data.productRows.map((row, index) => {
                  const share = data.total > 0 ? (row.valeur / data.total) * 100 : 0;
                  const barPct = maxValeur > 0 ? (row.valeur / maxValeur) * 100 : 0;
                  const productHref = detailHref(
                    `/detail/recouvrement/${encodeURIComponent(data.agencyCode)}/produit/${encodeURIComponent(row.code)}`,
                  );

                  return (
                    <tr key={`product-row-${row.code}`}>
                      <td>
                        <span className={`rank-chip${index < 3 ? ` top-${index + 1}` : ""}`}>
                          {index + 1}
                        </span>
                      </td>
                      <td>
                        <Link
                          href={productHref}
                          className="detail-drill-link"
                          title={`Voir les dossiers recouvres pour ${row.name}`}
                        >
                          <span className="collector-name">
                            <strong>{row.name}</strong>
                            <span>Code {row.code}</span>
                          </span>
                          <span className="detail-drill-sub">Liste des dossiers recouvres</span>
                        </Link>
                      </td>
                      <td>
                        <span className="collector-op-count">{row.code}</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span className="td-amount">{fmtCurrency.format(row.valeur)}</span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                        {fmtInt.format(row.dossiers)}
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                        {fmtInt.format(row.operations)}
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
                              background: barFill(index, data.productRows.length),
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {data.productRows.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucun recouvrement par produit sur la periode.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link href={detailHref("/detail/recouvrement")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au detail recouvrement
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO - Detail recouvrement {data.agencyCode}</span>
        <span className="footer-dot" />
        <span>Source : <code>CREDIT_PERTE</code> / <code>PRETS</code> / <code>DEMPRET</code> / <code>PRDT_CRD</code></span>
      </footer>
    </div>
  );
}
