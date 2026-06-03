"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

type LedgerEntry = {
  entryKey: number;
  lineNumber: number;
  operationDate: string;
  pieceNumber: string;
  systemPieceNumber: string;
  movementNumber: string;
  operationType: string;
  description: string;
  direction: string;
  debit: number;
  credit: number;
  signedAmount: number;
  runningBalance: number;
};

type LedgerPayload = {
  indicator: "resultat";
  agencyCode: string;
  agencyName: string;
  accountNumber: string;
  accountLabel: string;
  generalAccountNumber: string;
  generalAccountLabel: string;
  asOfDate: string;
  defaultStartDate: string;
  startDate: string;
  endDate: string;
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
  operations: number;
  entries: LedgerEntry[];
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

const fetcher = async (url: string): Promise<LedgerPayload> => {
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

function normalizeDateInput(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function addQuery(url: string, key: string, value: string | null) {
  if (!value) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

export function ResultatLedgerClient({
  agencyCode,
  accountNumber,
}: {
  agencyCode: string;
  accountNumber: string;
}) {
  const router = useRouter();
  const normalizedAgencyCode = decodeURIComponent(agencyCode).trim().toUpperCase();
  const normalizedAccountNumber = decodeURIComponent(accountNumber).trim().toUpperCase();
  const searchParams = useSearchParams();
  const asOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const startDateParam = normalizeDateInput(searchParams.get("startDate"));
  const endDateParam = normalizeDateInput(searchParams.get("endDate"));
  const detailHref = useCallback((href: string) => withAsOfDate(href, asOfDate), [asOfDate]);
  const apiUrl = useMemo(() => {
    let url = detailHref(
      `/api/detail/resultat/${encodeURIComponent(normalizedAgencyCode)}/compte/${encodeURIComponent(normalizedAccountNumber)}`,
    );
    url = addQuery(url, "startDate", startDateParam || null);
    url = addQuery(url, "endDate", endDateParam || null);
    return url;
  }, [detailHref, endDateParam, normalizedAccountNumber, normalizedAgencyCode, startDateParam]);

  const { data, error, isLoading } = useSWR(apiUrl, fetcher, { revalidateOnFocus: false });
  const [startDateDraft, setStartDateDraft] = useState("");
  const [endDateDraft, setEndDateDraft] = useState("");
  const startDateValue = startDateDraft || startDateParam || data?.startDate || "";
  const endDateValue = endDateDraft || endDateParam || data?.endDate || "";

  function submitPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let href = `/detail/resultat/${encodeURIComponent(normalizedAgencyCode)}/compte/${encodeURIComponent(normalizedAccountNumber)}`;
    href = withAsOfDate(href, asOfDate);
    href = addQuery(href, "startDate", normalizeDateInput(startDateValue) || null);
    href = addQuery(href, "endDate", normalizeDateInput(endDateValue) || null);
    router.push(href);
  }

  function resetPeriod() {
    setStartDateDraft("");
    setEndDateDraft("");
    router.push(
      withAsOfDate(
        `/detail/resultat/${encodeURIComponent(normalizedAgencyCode)}/compte/${encodeURIComponent(normalizedAccountNumber)}`,
        asOfDate,
      ),
    );
  }

  const header = (
    <header className="app-header">
      <Link
        href={detailHref(`/detail/resultat/${encodeURIComponent(normalizedAgencyCode)}`)}
        className="back-btn"
        title="Retour au plan comptable"
      >
        Retour
      </Link>
      <div className="header-sep" />
      <div className="header-brand">
        <div className="brand-logo">GL</div>
        <div>
          <div className="brand-name">Grand Livre du Compte</div>
          <div className="brand-sub">
            {data?.accountLabel ?? normalizedAccountNumber} - {data?.agencyName ?? normalizedAgencyCode}
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
              <div className="error-title">Erreur lors du chargement du grand livre</div>
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
          <div className="skeleton-panel" style={{ height: 500 }} />
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
            <div className="detail-summary-icon">GL</div>
            <div className="detail-summary-label">Solde final</div>
            <div className="detail-summary-value" style={{ color: amountColor(data.closingBalance) }}>
              {fmtCurrency.format(data.closingBalance)}
            </div>
            <div className="detail-summary-sub">
              Du {formatDate(data.startDate)} au {formatDate(data.endDate)}
            </div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--teal)" }}>
            <div className="detail-summary-icon">RP</div>
            <div className="detail-summary-label">Report avant periode</div>
            <div className="detail-summary-value" style={{ color: amountColor(data.openingBalance) }}>
              {fmtCurrency.format(data.openingBalance)}
            </div>
            <div className="detail-summary-sub">Solde strictement avant le {formatDate(data.startDate)}</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--red)" }}>
            <div className="detail-summary-icon">DB</div>
            <div className="detail-summary-label">Debit periode</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.periodDebit)}</div>
            <div className="detail-summary-sub">{fmtInt.format(data.operations)} operation(s)</div>
          </div>

          <div className="detail-summary-card" style={{ borderTopColor: "var(--objective-green)" }}>
            <div className="detail-summary-icon">CR</div>
            <div className="detail-summary-label">Credit periode</div>
            <div className="detail-summary-value">{fmtCurrency.format(data.periodCredit)}</div>
            <div className="detail-summary-sub">Date d&apos;arret : {formatDate(data.asOfDate)}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">Periode</div>
              <div className="panel-title">Bornes du grand livre</div>
            </div>
            <div className="detail-total-badge">
              Defaut : <strong>{formatDate(data.defaultStartDate)} - {formatDate(data.asOfDate)}</strong>
            </div>
          </div>
          <form
            onSubmit={submitPeriod}
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              alignItems: "end",
              padding: "0 18px 18px",
            }}
          >
            <label style={{ display: "grid", gap: 6, color: "var(--text-muted)", fontWeight: 700 }}>
              Date debut
              <input
                type="date"
                value={startDateValue}
                onChange={(event) => setStartDateDraft(event.target.value)}
                max={data.asOfDate}
                style={{ minWidth: 170 }}
              />
            </label>
            <label style={{ display: "grid", gap: 6, color: "var(--text-muted)", fontWeight: 700 }}>
              Date fin
              <input
                type="date"
                value={endDateValue}
                onChange={(event) => setEndDateDraft(event.target.value)}
                max={data.asOfDate}
                style={{ minWidth: 170 }}
              />
            </label>
            <button className="refresh-btn" type="submit">Appliquer</button>
            <button className="refresh-btn" type="button" onClick={resetPeriod}>Reinitialiser</button>
          </form>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">{data.generalAccountNumber} - {data.generalAccountLabel}</div>
              <div className="panel-title">
                <span className="collector-name">
                  <strong>{data.accountLabel}</strong>
                  <span>Compte {data.accountNumber}</span>
                </span>
              </div>
            </div>
            <div className="detail-total-badge">
              Solde : <strong style={{ color: amountColor(data.closingBalance) }}>{fmtCurrency.format(data.closingBalance)}</strong>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Piece</th>
                  <th>Libelle</th>
                  <th style={{ textAlign: "right" }}>Debit</th>
                  <th style={{ textAlign: "right" }}>Credit</th>
                  <th style={{ textAlign: "right" }}>Solde</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{formatDate(data.startDate)}</td>
                  <td>
                    <span className="collector-op-count">REPORT</span>
                  </td>
                  <td>
                    <span className="collector-name">
                      <strong>Report avant periode</strong>
                      <span>Operations strictement anterieures au {formatDate(data.startDate)}</span>
                    </span>
                  </td>
                  <td className="td-num" style={{ textAlign: "right" }}>-</td>
                  <td className="td-num" style={{ textAlign: "right" }}>-</td>
                  <td className="td-num" style={{ textAlign: "right" }}>
                    <span className="td-amount" style={{ color: amountColor(data.openingBalance) }}>
                      {fmtCurrency.format(data.openingBalance)}
                    </span>
                  </td>
                </tr>
                {data.entries.map((entry) => (
                  <tr key={entry.entryKey}>
                    <td>{formatDate(entry.operationDate)}</td>
                    <td>
                      <span className="collector-name">
                        <strong>{entry.pieceNumber || "-"}</strong>
                        <span>{entry.operationType || entry.movementNumber || "-"}</span>
                      </span>
                    </td>
                    <td>
                      <span className="collector-name">
                        <strong style={{ fontSize: "0.9rem" }}>{entry.description || "-"}</strong>
                        <span>Ligne {entry.lineNumber} - Sens {entry.direction || "-"}</span>
                      </span>
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: entry.debit > 0 ? "var(--red)" : "var(--text-muted)" }}>
                      {entry.debit > 0 ? fmtCurrency.format(entry.debit) : "-"}
                    </td>
                    <td className="td-num" style={{ textAlign: "right", color: entry.credit > 0 ? "var(--objective-green)" : "var(--text-muted)" }}>
                      {entry.credit > 0 ? fmtCurrency.format(entry.credit) : "-"}
                    </td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <span className="td-amount" style={{ color: amountColor(entry.runningBalance) }}>
                        {fmtCurrency.format(entry.runningBalance)}
                      </span>
                    </td>
                  </tr>
                ))}
                {data.entries.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                      Aucune operation sur ce compte dans la periode.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <Link
          href={detailHref(`/detail/resultat/${encodeURIComponent(data.agencyCode)}`)}
          style={{ color: "var(--teal)", textDecoration: "none" }}
        >
          Retour au plan comptable
        </Link>
        <span className="footer-dot" />
        <span>BASE_INTERCO - Grand livre {data.accountNumber}</span>
        <span className="footer-dot" />
        <span>Source : <code>HDPM</code></span>
      </footer>
    </div>
  );
}
