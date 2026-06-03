"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type DossierRow = {
  numDossier: string;
  customerCode: string;
  customerName: string;
  phoneNumber: string;
  lossTransferNumber: string;
  lossTransferDate: string;
  initialLossOutstanding: number;
  recoveredAmount: number;
  stockAmount: number;
};

type DossiersPayload = {
  indicator: "stock-perte";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  productCode: string;
  productName: string;
  totalStock: number;
  initialLossOutstanding: number;
  recoveredAmount: number;
  dossiersCount: number;
  dossiers: DossierRow[];
};

const fmtCurrency = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "XOF",
  maximumFractionDigits: 0,
});
const fmtInt = new Intl.NumberFormat("fr-FR");
const fmtDate = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const fetcher = async (url: string): Promise<DossiersPayload> => {
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

export function StockPerteDossiersClient({
  agencyCode,
  productCode,
}: {
  agencyCode: string;
  productCode: string;
}) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const normalizedProductCode = decodeURIComponent(productCode).trim();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const backHref = detailHref(`/detail/stock-perte/${encodeURIComponent(normalizedAgencyCode)}`);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/stock-perte/${encodeURIComponent(normalizedAgencyCode)}/produit/${encodeURIComponent(normalizedProductCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const header = (
    <header className="app-header">
      <Link href={backHref} className="back-btn" title="Retour aux produits">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">CD</div>
        <div>
          <div className="brand-name">Credits en Perte</div>
          <div className="brand-sub">
            {data
              ? `${data.agencyCode} - ${data.productCode}`
              : `${normalizedAgencyCode} - ${normalizedProductCode}`}
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
              <div className="error-title">Erreur lors du chargement des credits en perte</div>
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
          <div className="skeleton-panel" style={{ height: 420 }} />
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
            <div className="detail-summary-icon">SP</div>
            <div className="detail-summary-label">Stock net</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.totalStock)}</div>
            <div className="detail-summary-sub">Situation au {formatDate(data.asOfDate)}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">DS</div>
            <div className="detail-summary-label">Dossiers</div>
            <div className="detail-summary-value">{fmtInt.format(data.dossiersCount)}</div>
            <div className="detail-summary-sub">Credits en perte actifs</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--purple)" }}>
            <div className="detail-summary-icon">PR</div>
            <div className="detail-summary-label">Produit</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {data.productName}
            </div>
            <div className="detail-summary-sub">Code {data.productCode}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">RC</div>
            <div className="detail-summary-label">Recouvrements deduits</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.recoveredAmount)}</div>
            <div className="detail-summary-sub">
              Base initiale {fmtCurrency.format(data.initialLossOutstanding)}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Liste nominative</div>
              <div className="panel-title">
                Credits en perte - {data.productName} - {data.productCode}
              </div>
            </div>
            <div className="detail-total-badge">
              Total : <strong>{fmtCurrency.format(data.totalStock)}</strong>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Numero dossier</th>
                  <th>Client</th>
                  <th>Telephone</th>
                  <th>Transfert en perte</th>
                  <th>Date transfert</th>
                  <th style={{ textAlign: "right" }}>Stock initial</th>
                  <th style={{ textAlign: "right" }}>Recouvrements</th>
                  <th style={{ textAlign: "right" }}>Stock net</th>
                </tr>
              </thead>
              <tbody>
                {data.dossiers.map((row) => (
                  <tr key={row.numDossier}>
                    <td>
                      <span className="detail-agency-code">{row.numDossier}</span>
                    </td>
                    <td>
                      <div className="collector-name">
                        <strong>{row.customerName || "Client non identifie"}</strong>
                        <span>{row.customerCode || "Code adherent non identifie"}</span>
                      </div>
                    </td>
                    <td>{row.phoneNumber || "-"}</td>
                    <td>{row.lossTransferNumber || "-"}</td>
                    <td style={{ color: "var(--text-muted)", fontWeight: 700 }}>
                      {formatDate(row.lossTransferDate)}
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                      {fmtCurrency.format(row.initialLossOutstanding)}
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                      {fmtCurrency.format(row.recoveredAmount)}
                    </td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount">{fmtCurrency.format(row.stockAmount)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link href={backHref} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour aux produits stock en perte
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>DECLAS_HIST</code> / <code>CREDIT_PERTE</code> / <code>PRETS</code> / <code>DEMPRET</code> / <code>ADHERENT</code></span>
      </footer>
    </div>
  );
}
