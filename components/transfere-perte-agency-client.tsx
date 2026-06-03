"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type ProductRow = {
  code: string;
  name: string;
  valeur: number;
  dossiers: number;
  grossOutstanding: number;
  guaranteesDeducted: number;
  averageAmount: number;
};

type TransferePertePayload = {
  indicator: "transfere-perte";
  label: string;
  unit: "currency";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart: string;
  total: number;
  dossiers: number;
  grossOutstanding: number;
  guaranteesDeducted: number;
  averageAmount: number;
  productRows: ProductRow[];
};

const fmtCurrency = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "XOF",
  maximumFractionDigits: 0,
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

const fetcher = async (url: string): Promise<TransferePertePayload> => {
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

function barFill(index: number, total: number): string {
  const opacity = Math.max(0.34, 1 - (index / (total || 1)) * 0.55);
  return `rgba(194,65,59,${opacity})`;
}

export function TransferePerteAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/transfere-perte/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const topProduct = data?.productRows[0] ?? null;
  const maxValeur = data?.productRows[0]?.valeur ?? 1;

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/transfere-perte")} className="back-btn" title="Retour au detail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">TP</div>
        <div>
          <div className="brand-name">Transfere en Perte par Produit</div>
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
              <div className="error-title">Erreur lors du chargement des transferts en perte</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: "var(--red)" }}>
            <div className="detail-summary-icon">TP</div>
            <div className="detail-summary-label">Montant transfere</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.total)}</div>
            <div className="detail-summary-sub">
              Periode du {formatDate(data.monthStart)} au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">DS</div>
            <div className="detail-summary-label">Dossiers</div>
            <div className="detail-summary-value">{fmtInt.format(data.dossiers)}</div>
            <div className="detail-summary-sub">Credits transferes en perte</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--purple)" }}>
            <div className="detail-summary-icon">PR</div>
            <div className="detail-summary-label">Premier produit</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {topProduct ? topProduct.code : "-"}
            </div>
            <div className="detail-summary-sub">
              {topProduct ? topProduct.name : "Aucun transfert"}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">GT</div>
            <div className="detail-summary-label">Garanties deduites</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.guaranteesDeducted)}</div>
            <div className="detail-summary-sub">
              Encours brut {fmtCurrency.format(data.grossOutstanding)}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Produit de credit</div>
              <div className="panel-title">
                {data.agencyCode} - Repartition des transferts en perte par produit
              </div>
            </div>
            <div className="detail-total-badge">
              Total : <strong>{fmtCurrency.format(data.total)}</strong>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Rang</th>
                  <th>Produit de credit</th>
                  <th>Code</th>
                  <th style={{ textAlign: "right" }}>Montant transfere</th>
                  <th style={{ textAlign: "right" }}>Dossiers</th>
                  <th style={{ textAlign: "right" }}>Encours brut</th>
                  <th style={{ textAlign: "right" }}>Garanties deduites</th>
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
                    `/detail/transfere-perte/${encodeURIComponent(data.agencyCode)}/produit/${encodeURIComponent(row.code)}`,
                  );

                  return (
                    <tr key={`transfer-product-row-${row.code}`}>
                      <td>
                        <span className={`rank-chip${index < 3 ? ` top-${index + 1}` : ""}`}>
                          {index + 1}
                        </span>
                      </td>
                      <td>
                        <Link
                          href={productHref}
                          className="detail-drill-link"
                          title={`Voir les credits transferes en perte pour ${row.name}`}
                        >
                          <span className="collector-name">
                            <strong>{row.name}</strong>
                            <span>Code {row.code}</span>
                          </span>
                          <span className="detail-drill-sub">Liste nominative des credits</span>
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
                        {fmtCurrency.format(row.grossOutstanding)}
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                        {fmtCurrency.format(row.guaranteesDeducted)}
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
                    <td colSpan={10} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucun transfert en perte par produit sur la periode.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link href={detailHref("/detail/transfere-perte")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au detail transfere en perte
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO - Detail transfere en perte {data.agencyCode}</span>
        <span className="footer-dot" />
        <span>Source : <code>DECLAS_HIST</code> / <code>PRETS</code> / <code>DEMPRET</code> / <code>PRDT_CRD</code></span>
      </footer>
    </div>
  );
}
