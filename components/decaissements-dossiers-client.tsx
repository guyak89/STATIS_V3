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
  productCode: string;
  productName: string;
  managerCode: string;
  managerName: string;
  montantDecaisse: number;
  operations: number;
  firstDecaissementDate: string;
  lastDecaissementDate: string;
  lastTransactionNumber: string;
};

type DossiersPayload = {
  indicator: "decaissements";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart: string;
  groupType: "produit" | "gestionnaire";
  groupCode: string;
  groupName: string;
  totalDecaisse: number;
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

export function DecaissementsDossiersClient({
  agencyCode,
  groupType,
  code,
}: {
  agencyCode: string;
  groupType: string;
  code: string;
}) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const normalizedGroupType = decodeURIComponent(groupType).trim().toLowerCase();
  const normalizedCode = decodeURIComponent(code).trim();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const backHref = detailHref(`/detail/decaissements/${encodeURIComponent(normalizedAgencyCode)}`);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/decaissements/${encodeURIComponent(normalizedAgencyCode)}/${encodeURIComponent(normalizedGroupType)}/${encodeURIComponent(normalizedCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const header = (
    <header className="app-header">
      <Link href={backHref} className="back-btn" title="Retour aux repartitions">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">DD</div>
        <div>
          <div className="brand-name">Dossiers decaisses</div>
          <div className="brand-sub">
            {data
              ? `${data.agencyCode} - ${data.groupType} ${data.groupCode}`
              : `${normalizedAgencyCode} - ${normalizedGroupType} ${normalizedCode}`}
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
              <div className="error-title">Erreur lors du chargement des dossiers decaisses</div>
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
          <div className="detail-summary-card" style={{ borderTopColor: "var(--blue)" }}>
            <div className="detail-summary-icon">DC</div>
            <div className="detail-summary-label">Total decaisse</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.totalDecaisse)}</div>
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

          <div className="detail-summary-card" style={{ borderTopColor: "var(--green)" }}>
            <div className="detail-summary-icon">{data.groupType === "produit" ? "PR" : "GE"}</div>
            <div className="detail-summary-label">{data.groupType === "produit" ? "Produit" : "Gestionnaire"}</div>
            <div className="detail-summary-value" style={{ fontSize: "1.2rem" }}>
              {data.groupName}
            </div>
            <div className="detail-summary-sub">Code {data.groupCode}</div>
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
                Dossiers decaisses - {data.groupType === "produit" ? "Produit" : "Gestionnaire"} {data.groupName} - {data.groupCode}
              </div>
            </div>
            <div className="detail-total-badge">
              Total : <strong>{fmtCurrency.format(data.totalDecaisse)}</strong>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Numero dossier</th>
                  <th>Client</th>
                  <th>Telephone</th>
                  <th>Produit</th>
                  <th>Gestionnaire</th>
                  <th>Premiere date</th>
                  <th>Derniere date</th>
                  <th>Derniere transaction</th>
                  <th style={{ textAlign: "right" }}>Operations</th>
                  <th style={{ textAlign: "right" }}>Montant decaisse</th>
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
                    <td>
                      <div className="collector-name">
                        <strong>{row.productName || "Produit non identifie"}</strong>
                        <span>{row.productCode || "Code produit non identifie"}</span>
                      </div>
                    </td>
                    <td>
                      <div className="collector-name">
                        <strong>{row.managerName || "Gestionnaire non identifie"}</strong>
                        <span>{row.managerCode || "Code gestionnaire non identifie"}</span>
                      </div>
                    </td>
                    <td style={{ color: "var(--text-muted)", fontWeight: 700 }}>
                      {formatDate(row.firstDecaissementDate)}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontWeight: 700 }}>
                      {formatDate(row.lastDecaissementDate)}
                    </td>
                    <td>{row.lastTransactionNumber || "-"}</td>
                    <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                      {fmtInt.format(row.operations)}
                    </td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount">{fmtCurrency.format(row.montantDecaisse)}</span>
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
          Retour aux repartitions decaissements
        </Link>
        <span className="footer-dot" />
        <span>Source : <code>DECAIS</code> / <code>PRETS</code> / <code>DEMPRET</code> / <code>ADHERENT</code></span>
      </footer>
    </div>
  );
}
