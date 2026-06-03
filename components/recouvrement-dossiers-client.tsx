"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type DossierRow = {
  numDossier: string;
  customerCode: string;
  customerName: string;
  montantRecouvre: number;
  operations: number;
  firstOperationDate: string;
  lastOperationDate: string;
  modePaiement: string;
  utilisateur: string;
  cashDeskKey: string;
};

type DossiersPayload = {
  indicator: "recouvrement";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart: string;
  productCode: string;
  productName: string;
  totalRecouvre: number;
  operations: number;
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

export function RecouvrementDossiersClient({
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
  const backHref = detailHref(`/detail/recouvrement/${encodeURIComponent(normalizedAgencyCode)}`);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/recouvrement/${encodeURIComponent(normalizedAgencyCode)}/produit/${encodeURIComponent(normalizedProductCode)}`),
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
        <div className="brand-logo">RD</div>
        <div>
          <div className="brand-name">Dossiers recouvres</div>
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
              <div className="error-title">Erreur lors du chargement des dossiers recouvres</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
            <div className="detail-summary-icon">RC</div>
            <div className="detail-summary-label">Total recouvre</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.totalRecouvre)}</div>
            <div className="detail-summary-sub">
              Periode du {formatDate(data.monthStart)} au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">DS</div>
            <div className="detail-summary-label">Dossiers</div>
            <div className="detail-summary-value">{fmtInt.format(data.dossiersCount)}</div>
            <div className="detail-summary-sub">
              {fmtInt.format(data.operations)} operation(s)
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--purple)" }}>
            <div className="detail-summary-icon">PR</div>
            <div className="detail-summary-label">Produit</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {data.productName}
            </div>
            <div className="detail-summary-sub">Code {data.productCode}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--amber)" }}>
            <div className="detail-summary-icon">AG</div>
            <div className="detail-summary-label">Mutuelle</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {data.agencyCode}
            </div>
            <div className="detail-summary-sub">{data.agencyName}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Liste nominative</div>
              <div className="panel-title">
                Dossiers recouvres - {data.productName} - {data.productCode}
              </div>
            </div>
            <div className="detail-total-badge">
              Total : <strong>{fmtCurrency.format(data.totalRecouvre)}</strong>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Numero dossier</th>
                  <th>Client</th>
                  <th style={{ textAlign: "right" }}>Montant recouvre</th>
                  <th style={{ textAlign: "right" }}>Operations</th>
                  <th>Premiere operation</th>
                  <th>Derniere operation</th>
                  <th>Mode</th>
                  <th>Utilisateur</th>
                  <th>Caisse</th>
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
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount">{fmtCurrency.format(row.montantRecouvre)}</span>
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                      {fmtInt.format(row.operations)}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontWeight: 700 }}>
                      {formatDate(row.firstOperationDate)}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontWeight: 700 }}>
                      {formatDate(row.lastOperationDate)}
                    </td>
                    <td>{row.modePaiement || "-"}</td>
                    <td>{row.utilisateur || "-"}</td>
                    <td>{row.cashDeskKey || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link href={backHref} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour aux produits recouvres
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>CREDIT_PERTE</code> / <code>PRETS</code> / <code>DEMPRET</code> / <code>ADHERENT</code></span>
      </footer>
    </div>
  );
}
