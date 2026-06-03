"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment } from "react";
import useSWR from "swr";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type AccountRow = {
  accountNumber: string;
  accountLabel: string;
  balance: number;
  operations: number;
};

type GeneralAccountRow = {
  generalAccountNumber: string;
  generalAccountLabel: string;
  balance: number;
  operations: number;
  accountCount: number;
  accounts: AccountRow[];
};

type ResultSection = {
  sectionCode: "products" | "expenses";
  sectionLabel: string;
  total: number;
  generalAccounts: GeneralAccountRow[];
};

type ResultatPayload = {
  indicator: "resultat";
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  exerciseStart: string;
  productsTotal: number;
  expensesTotal: number;
  resultTotal: number;
  accountCount: number;
  operations: number;
  sections: ResultSection[];
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

const fetcher = async (url: string): Promise<ResultatPayload> => {
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

function amountColor(value: number) {
  if (value > 0) return "var(--objective-green)";
  if (value < 0) return "var(--red)";
  return "var(--text-muted)";
}

function share(value: number, total: number) {
  return total !== 0 ? Math.abs(value / total) * 100 : 0;
}

function SectionTable({
  agencyCode,
  detailHref,
  section,
}: {
  agencyCode: string;
  detailHref: (href: string) => string;
  section: ResultSection;
}) {
  const maxAbs = Math.max(
    1,
    ...section.generalAccounts.map((row) => Math.abs(row.balance)),
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker">Plan comptable</div>
          <div className="panel-title">{section.sectionLabel} par compte general</div>
        </div>
        <div className="detail-total-badge">
          Total : <strong style={{ color: amountColor(section.total) }}>{fmtCurrency.format(section.total)}</strong>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Compte</th>
              <th style={{ textAlign: "right" }}>Solde</th>
              <th style={{ textAlign: "right" }}>Operations</th>
              <th style={{ width: 160 }}>Poids</th>
            </tr>
          </thead>
          <tbody>
            {section.generalAccounts.map((general) => {
              const barPct = share(general.balance, maxAbs);

              return (
                <Fragment key={`group-${section.sectionCode}-${general.generalAccountNumber}`}>
                  <tr key={`general-${section.sectionCode}-${general.generalAccountNumber}`}>
                    <td>
                      <span className="collector-name">
                        <strong>{general.generalAccountLabel}</strong>
                        <span>Compte general {general.generalAccountNumber}</span>
                      </span>
                    </td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount" style={{ color: amountColor(general.balance) }}>
                        {fmtCurrency.format(general.balance)}
                      </span>
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                      {fmtInt.format(general.operations)}
                    </td>
                    <td>
                      <div className="detail-minibar-track">
                        <div
                          className="detail-minibar-fill"
                          style={{
                            width: `${barPct}%`,
                            background: section.sectionCode === "products"
                              ? "var(--objective-green)"
                              : "var(--red)",
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                  {general.accounts.map((account) => (
                    <tr key={`account-${section.sectionCode}-${account.accountNumber}`}>
                      <td style={{ paddingLeft: 34 }}>
                        <Link
                          href={detailHref(
                            `/detail/resultat/${encodeURIComponent(agencyCode)}/compte/${encodeURIComponent(account.accountNumber)}`,
                          )}
                          className="detail-drill-link"
                          title={`Voir le grand livre du compte ${account.accountNumber}`}
                        >
                          <span className="collector-name">
                            <strong style={{ fontSize: "0.9rem" }}>{account.accountLabel}</strong>
                            <span>Compte {account.accountNumber}</span>
                          </span>
                          <span className="detail-drill-sub">Grand livre du compte</span>
                        </Link>
                      </td>
                      <td className="td-num" style={{ textAlign: "right" }}>
                        <span className="td-amount" style={{ color: amountColor(account.balance) }}>
                          {fmtCurrency.format(account.balance)}
                        </span>
                      </td>
                      <td className="td-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                        {fmtInt.format(account.operations)}
                      </td>
                      <td>
                        <div className="detail-minibar-track">
                          <div
                            className="detail-minibar-fill"
                            style={{
                              width: `${share(account.balance, maxAbs)}%`,
                              opacity: 0.45,
                              background: section.sectionCode === "products"
                                ? "var(--objective-green)"
                                : "var(--red)",
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {section.generalAccounts.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                  Aucun compte mouvemente sur la periode.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ResultatAgencyClient({ agencyCode }: { agencyCode: string }) {
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const detailHref = (href: string) => withAsOfDate(href, asOfDate);
  const { data, error, isLoading } = useSWR(
    detailHref(`/api/detail/resultat/${encodeURIComponent(normalizedAgencyCode)}`),
    fetcher,
    { revalidateOnFocus: false },
  );

  const header = (
    <header className="app-header">
      <Link href={detailHref("/detail/resultat")} className="back-btn" title="Retour au detail par agence">
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">RS</div>
        <div>
          <div className="brand-name">Resultat par Plan Comptable</div>
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
              <div className="error-title">Erreur lors du chargement du detail resultat</div>
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
            <div className="detail-summary-icon">RS</div>
            <div className="detail-summary-label">Resultat</div>
            <div className="detail-summary-value" style={{ color: amountColor(data.resultTotal) }}>
              {fmtCurrency.format(data.resultTotal)}
            </div>
            <div className="detail-summary-sub">
              Exercice du {formatDate(data.exerciseStart)} au {formatDate(data.asOfDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--objective-green)" }}>
            <div className="detail-summary-icon">PR</div>
            <div className="detail-summary-label">Produits</div>
            <div className="detail-summary-value" style={{ color: amountColor(data.productsTotal) }}>
              {fmtCurrency.format(data.productsTotal)}
            </div>
            <div className="detail-summary-sub">Classe 7</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--red)" }}>
            <div className="detail-summary-icon">CH</div>
            <div className="detail-summary-label">Charges</div>
            <div className="detail-summary-value" style={{ color: amountColor(data.expensesTotal) }}>
              {fmtCurrency.format(data.expensesTotal)}
            </div>
            <div className="detail-summary-sub">Classe 6</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">CP</div>
            <div className="detail-summary-label">Comptes mouvementes</div>
            <div className="detail-summary-value">{fmtInt.format(data.accountCount)}</div>
            <div className="detail-summary-sub">
              {fmtInt.format(data.operations)} operation(s)
            </div>
          </div>
        </div>

        {data.sections.map((section) => (
          <SectionTable
            key={section.sectionCode}
            agencyCode={data.agencyCode}
            detailHref={detailHref}
            section={section}
          />
        ))}
      </div>

      <footer className="app-footer">
        <Link href={detailHref("/detail/resultat")} style={{ color: "var(--teal)", textDecoration: "none" }}>
          Retour au detail resultat
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO - Detail resultat {data.agencyCode}</span>
        <span className="footer-dot" />
        <span>Source : <code>HDPM</code> / <code>COMPTES</code> / <code>PLANCPTE</code></span>
      </footer>
    </div>
  );
}
