"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ValueType } from "recharts/types/component/DefaultTooltipContent";
import { AppBrandBlock, useBranding } from "@/components/app-branding";
import { exportDashboardToExcel } from "@/lib/excel-export";
import { normalizeHistoricalDate, withAsOfDate } from "@/lib/historical-url";

/* ═══════════════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════════════ */

type Overview = {
  asOf: string;
  operationalDate: string;
  openDate: string;
  isHistorical: boolean;
  periodLabel: string;
  totalAdherents: number;
  newAdherentsPeriod: number;
  activeAgencies: number;
  totalLoanAmount: number;
  totalSavingsAmount: number | null;
  savingsSnapshotPeriod: string | null;
  par1Amount: number; par30Amount: number; par90Amount: number;
  par1Rate: number;  par30Rate: number;  par90Rate: number;
  totalImpayes: number;
  totalResult: number;
  tontineCollectionPeriod: number;
  tontineDepositsCount: number;
  tontineSubscriptionsPeriod: number;
  decaissementsPeriod: number;
  decaissementsCount: number;
  stockCreditLoss: number;
  creditTransferredToLossPeriod: number;
  creditTransferredToLossCount: number;
  creditRecoveryPeriod: number;
  creditRecoveryCount: number;
  cashInAmount: number;
  cashOutAmount: number;
  cashOperationsCount: number;
  mobileMoneyDepositAmount: number;
  mobileMoneyWithdrawalAmount: number;
  mobileMoneyOperationsCount: number;
  treasuryCashAmount: number;
  treasuryBankAmount: number;
  treasuryTotalAmount: number;
};

type AdherentTrend  = { label: string; total: number };
type DecaissTrend   = { label: string; total: number; count: number };
type AgencyPerf     = { agencyCode: string; agencyName: string; adherents: number; loans: number; loanAmount: number };
type LoanStatus     = { statusCode: string; totalLoans: number; totalAmount: number };

type AgencySettingsPayload = {
  centralAgencyCode: string;
  includeCentralAgency: boolean;
  consoMutuellesActive?: boolean;
  activeProfile?: {
    id: string;
    name: string;
    agencyCodes: string[];
  } | null;
  storagePath?: string;
  updatedAt?: string | null;
};

type AgencyProfile = {
  id: string;
  name: string;
  agencyCodes: string[];
};

type DashboardPayload = {
  overview: Overview;
  adherentTrend: AdherentTrend[];
  agencyPerformance: AgencyPerf[];
  loanStatus: LoanStatus[];
  decaissementTrend: DecaissTrend[];
  objectifs: Record<string, number>;
  hasObjectifs: boolean;
  agencySettings: AgencySettingsPayload;
};

/* ═══════════════════════════════════════════════════════════════
   FORMATTERS
═══════════════════════════════════════════════════════════════ */

const fmtCurrency = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "XOF", maximumFractionDigits: 0 });
const fmtCompact  = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const fmtPct      = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt      = new Intl.NumberFormat("fr-FR");
const fmtDateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
const fmtMonth    = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit" });

function cur(v: number | null | undefined) { return fmtCurrency.format(v ?? 0); }
function cpt(v: number | null | undefined) { return fmtCompact.format(v ?? 0); }
function pct(v: number | null | undefined) { return `${fmtPct.format(v ?? 0)} %`; }
function num(v: number | null | undefined) { return fmtInt.format(v ?? 0); }
function toNumber(value: ValueType | null | undefined) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function labelToDate(label: string) {
  const [y, m] = label.split("-");
  return new Date(Number(y), Number(m) - 1, 1);
}

function shortMonth(label: string) {
  return fmtMonth.format(labelToDate(label));
}

function useHistoricalHref(href: string) {
  const searchParams = useSearchParams();
  return withAsOfDate(href, searchParams.get("asOfDate"));
}

/* ═══════════════════════════════════════════════════════════════
   RISK HELPER
═══════════════════════════════════════════════════════════════ */

type RiskLevel = "faible" | "modéré" | "élevé" | "critique";

function riskLevel(rate: number): RiskLevel {
  if (rate < 3)  return "faible";
  if (rate < 8)  return "modéré";
  if (rate < 15) return "élevé";
  return "critique";
}

function riskBarColor(level: RiskLevel) {
  const map: Record<RiskLevel, string> = {
    "faible":   "c-green",
    "modéré":   "c-amber",
    "élevé":    "c-red",
    "critique": "c-red",
  };
  return map[level];
}

/* ═══════════════════════════════════════════════════════════════
   CHART COLORS
═══════════════════════════════════════════════════════════════ */

const LOAN_STATUS_COLORS: Record<string, string> = {
  DC: "var(--teal)",
  SO: "var(--amber)",
  SD: "#826b70",
  PE: "var(--red)",
};
const LOAN_STATUS_LABELS: Record<string, string> = {
  DC: "Décaissé (sain)",
  SO: "En souffrance",
  SD: "Soldé",
  PE: "En perte",
};

/* ═══════════════════════════════════════════════════════════════
   FETCHER
═══════════════════════════════════════════════════════════════ */

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DASHBOARD_REFRESH_URL = "/api/dashboard?refresh=1";

const fetcher = async (url: string): Promise<DashboardPayload> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

// Fetcher spécial pour le bouton "Actualiser" : force le recalcul côté serveur
const forceFetcher = async (url: string): Promise<DashboardPayload> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

/* ═══════════════════════════════════════════════════════════════
   OBJECTIF HELPERS
═══════════════════════════════════════════════════════════════ */

// Indicateurs où la valeur DOIT être inférieure à l'objectif
const LOWER_IS_BETTER_SET = new Set([
  "par-1j","par-30j","par-90j","impayes","stock-perte","transfere-perte",
]);

function objAchievement(actual: number, objectif: number): number {
  if (!objectif || objectif === 0) return 0;
  return (actual / objectif) * 100;
}

function objColor(slug: string, pct: number): "obj-green" | "obj-amber" | "obj-red" {
  const lowerIsBetter = LOWER_IS_BETTER_SET.has(slug);
  if (lowerIsBetter) {
    if (pct <= 100) return "obj-green";
    if (pct <= 125) return "obj-amber";
    return "obj-red";
  }
  if (pct >= 100) return "obj-green";
  if (pct >= 80)  return "obj-amber";
  return "obj-red";
}

function objLabel(slug: string, pct: number): string {
  const lowerIsBetter = LOWER_IS_BETTER_SET.has(slug);
  if (lowerIsBetter) {
    return pct <= 100 ? `${fmtPct.format(pct)} obj. ✓` : `${fmtPct.format(pct)} obj. ↑`;
  }
  return pct >= 100 ? `${fmtPct.format(pct)} obj. ✓` : `${fmtPct.format(pct)} obj.`;
}

/* Mini progress bar shown on cards when an objective is set */
function ObjectifBar({
  actual, objectif, slug, unit,
}: {
  actual: number; objectif: number; slug: string; unit?: string;
}) {
  if (!objectif || objectif === 0) return null;
  const lowerIsBetter = LOWER_IS_BETTER_SET.has(slug);
  const pctVal = objAchievement(actual, objectif);
  const colorClass = objColor(slug, pctVal);
  // Fill: for lower-is-better, show how much of the objective has been used
  const fillPct = lowerIsBetter ? Math.min(pctVal, 150) / 1.5 : Math.min(pctVal, 100);
  const fmtObj = unit === "count"
    ? fmtInt.format(objectif)
    : fmtCompact.format(objectif) + (unit === "percent" ? " %" : " XOF");

  return (
    <div className="obj-wrap">
      <div className="obj-bar-track">
        <div className={`obj-bar-fill ${colorClass}`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className="obj-meta">
        <span className="obj-target">Obj : {fmtObj}</span>
        <span className={`obj-pct ${colorClass}`}>{objLabel(slug, pctVal)}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SUB-COMPONENTS
═══════════════════════════════════════════════════════════════ */

/* ── KPI Card ─────────────────────────────────────────────── */
function KpiCard({
  label, value, detail, sub, icon,
  topColor, glowColor, iconBg, href, slug, actual, objectif, unit,
}: {
  label: string; value: string; detail?: string; sub?: string;
  icon: string; topColor: string; glowColor: string; iconBg: string;
  href: string; slug: string; actual: number; objectif?: number;
  unit?: string;
}) {
  const linkedHref = useHistoricalHref(href);
  return (
    <Link href={linkedHref} className="kpi-card card-link"
      style={{ "--card-top": topColor, "--card-glow": glowColor, "--icon-bg": iconBg } as React.CSSProperties}
    >
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {detail && <div className="kpi-detail">{detail}</div>}
      {sub    && <div className="kpi-sub">{sub}</div>}
      {objectif !== undefined && (
        <ObjectifBar actual={actual} objectif={objectif} slug={slug} unit={unit ?? "currency"} />
      )}
      <div className="card-drill-hint">Voir le détail →</div>
    </Link>
  );
}

/* ── PAR Card ─────────────────────────────────────────────── */
function ParCard({
  label, rate, amount, totalLoan, href, slug, objectif,
}: {
  label: string; rate: number; amount: number; totalLoan: number;
  href: string; slug: string; objectif?: number;
}) {
  const linkedHref = useHistoricalHref(href);
  const level = riskLevel(rate);
  const barPct = Math.min(rate * 2, 100);
  return (
    <Link href={linkedHref} className={`par-card risk-${level} card-link`}>
      <div className="par-header">
        <span className="par-label">{label}</span>
        <span className={`risk-badge risk-${level}`}>{level.toUpperCase()}</span>
      </div>
      <div className="par-rate">{pct(rate)}</div>
      <div className="par-bar-track">
        <div className={`par-bar-fill ${riskBarColor(level)}`} style={{ width: `${barPct}%` }} />
      </div>
      <div className="par-amount">{cur(amount)}</div>
      <div className="par-sub">{totalLoan > 0 ? `sur ${cur(totalLoan)} d'encours` : "encours en cours de calcul"}</div>
      {objectif !== undefined && (
        <ObjectifBar actual={rate} objectif={objectif} slug={slug} unit="percent" />
      )}
      <div className="card-drill-hint">Voir le détail →</div>
    </Link>
  );
}

/* ── Ops Card ─────────────────────────────────────────────── */
function OpsCard({
  label, value, detail, icon, bg, color, href,
  slug, actual, objectif, unit,
}: {
  label: string; value: string; detail?: string;
  icon: string; bg: string; color: string; href: string;
  slug: string; actual: number; objectif?: number; unit?: string;
}) {
  const linkedHref = useHistoricalHref(href);
  return (
    <Link href={linkedHref} className="ops-card card-link">
      <div className="ops-icon-wrap" style={{ background: bg, color }}>{icon}</div>
      <div className="ops-label">{label}</div>
      <div className="ops-value">{value}</div>
      {detail && <div className="ops-detail">{detail}</div>}
      {objectif !== undefined && (
        <ObjectifBar actual={actual} objectif={objectif} slug={slug} unit={unit ?? "currency"} />
      )}
      <div className="card-drill-hint" style={{ marginTop: "auto" }}>Voir le détail →</div>
    </Link>
  );
}

/* ── Skeleton ─────────────────────────────────────────────── */
function CashOpsCard({
  cashIn,
  cashOut,
  count,
  href,
  objectif,
}: {
  cashIn: number;
  cashOut: number;
  count: number;
  href: string;
  objectif?: number;
}) {
  const linkedHref = useHistoricalHref(href);
  const total = cashIn + cashOut;

  return (
    <Link href={linkedHref} className="ops-card cash-ops-card card-link">
      <div className="ops-icon-wrap" style={{ background: "var(--teal-soft)", color: "var(--teal)" }}>⇅</div>
      <div className="ops-label">Opérations de caisse</div>
      <div className="cash-flow-pair">
        <div className="cash-flow-line cash-flow-in">
          <span className="cash-flow-arrow">↗</span>
          <span>
            <small>Entrées</small>
            <strong>{cur(cashIn)}</strong>
          </span>
        </div>
        <div className="cash-flow-line cash-flow-out">
          <span className="cash-flow-arrow">↘</span>
          <span>
            <small>Sorties</small>
            <strong>{cur(cashOut)}</strong>
          </span>
        </div>
      </div>
      <div className="ops-detail">{num(count)} opération(s) aujourd&apos;hui</div>
      {objectif !== undefined && (
        <ObjectifBar actual={total} objectif={objectif} slug="operations-caisse" unit="currency" />
      )}
      <div className="card-drill-hint" style={{ marginTop: "auto" }}>Voir le détail →</div>
    </Link>
  );
}

function MobileMoneyCard({
  deposits,
  withdrawals,
  count,
  href,
  objectif,
}: {
  deposits: number;
  withdrawals: number;
  count: number;
  href: string;
  objectif?: number;
}) {
  const linkedHref = useHistoricalHref(href);
  const total = deposits + withdrawals;

  return (
    <Link href={linkedHref} className="ops-card cash-ops-card card-link">
      <div className="ops-icon-wrap" style={{ background: "var(--blue-soft)", color: "var(--blue)" }}>MM</div>
      <div className="ops-label">Mobile Money</div>
      <div className="cash-flow-pair">
        <div className="cash-flow-line cash-flow-in">
          <span className="cash-flow-arrow">↗</span>
          <span>
            <small>Dépôts</small>
            <strong>{cur(deposits)}</strong>
          </span>
        </div>
        <div className="cash-flow-line cash-flow-out">
          <span className="cash-flow-arrow">↘</span>
          <span>
            <small>Retraits</small>
            <strong>{cur(withdrawals)}</strong>
          </span>
        </div>
      </div>
      <div className="ops-detail">{num(count)} opération(s) aujourd&apos;hui</div>
      {objectif !== undefined && (
        <ObjectifBar actual={total} objectif={objectif} slug="mobile-money" unit="currency" />
      )}
      <div className="card-drill-hint" style={{ marginTop: "auto" }}>Voir le détail →</div>
    </Link>
  );
}

function TreasuryCard({
  cash,
  bank,
  href,
  objectif,
}: {
  cash: number;
  bank: number;
  href: string;
  objectif?: number;
}) {
  const linkedHref = useHistoricalHref(href);
  const total = cash + bank;

  return (
    <Link href={linkedHref} className="ops-card cash-ops-card card-link">
      <div className="ops-icon-wrap" style={{ background: "var(--green-soft)", color: "var(--green)" }}>T</div>
      <div className="ops-label">Trésorerie</div>
      <div className="ops-value">{cur(total)}</div>
      <div className="cash-flow-pair">
        <div className="cash-flow-line cash-flow-in">
          <span className="cash-flow-arrow">C</span>
          <span>
            <small>Caisses</small>
            <strong>{cur(cash)}</strong>
          </span>
        </div>
        <div className="cash-flow-line cash-flow-out">
          <span className="cash-flow-arrow">B</span>
          <span>
            <small>Banques</small>
            <strong>{cur(bank)}</strong>
          </span>
        </div>
      </div>
      {objectif !== undefined && (
        <ObjectifBar actual={total} objectif={objectif} slug="tresorerie" unit="currency" />
      )}
      <div className="card-drill-hint" style={{ marginTop: "auto" }}>Voir le détail →</div>
    </Link>
  );
}

function SkeletonDashboard() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="skeleton-grid">
        {[0,1,2,3].map(i => <div key={i} className="skeleton-card" />)}
      </div>
      <div className="skeleton-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        {[0,1,2].map(i => <div key={i} className="skeleton-card" />)}
      </div>
      <div className="skeleton-grid">
        {[0,1,2,3].map(i => <div key={i} className="skeleton-card" style={{ height: 100 }} />)}
      </div>
      <div className="skeleton-panel" />
    </div>
  );
}

/* ── Custom Tooltip ───────────────────────────────────────── */
function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name?: string; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      {label && <div className="tt-label">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color ?? "var(--text)", fontWeight: 700 }}>
          {cpt(p.value)}
        </div>
      ))}
    </div>
  );
}

function CurrencyTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      {label && <div className="tt-label">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color ?? "var(--text)", fontWeight: 700 }}>
          {cur(p.value)}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════ */

export function DashboardClient() {
  const branding   = useBranding();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialHistoricalDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
  const [refreshing, setRefreshing] = useState(false);
  const [savingFaitiere, setSavingFaitiere] = useState(false);
  const [faitiereError, setFaitiereError] = useState<string | null>(null);
  const [historicalEnabled, setHistoricalEnabled] = useState(Boolean(initialHistoricalDate));
  const [historicalDate, setHistoricalDate] = useState(initialHistoricalDate ?? "");
  const [profiles, setProfiles] = useState<AgencyProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profilePin, setProfilePin] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const appliedAsOfDate = historicalEnabled ? normalizeHistoricalDate(historicalDate) : null;
  const dashboardUrl = useMemo(
    () => withAsOfDate(DASHBOARD_REFRESH_URL, appliedAsOfDate),
    [appliedAsOfDate],
  );

  useEffect(() => {
    const currentQuery = searchParams.toString();
    const currentAsOfDate = normalizeHistoricalDate(searchParams.get("asOfDate"));
    if (currentAsOfDate === appliedAsOfDate) return;

    const params = new URLSearchParams(searchParams.toString());
    if (appliedAsOfDate) {
      params.set("asOfDate", appliedAsOfDate);
    } else {
      params.delete("asOfDate");
    }
    const nextUrl = `${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    const currentUrl = `${pathname}${currentQuery ? `?${currentQuery}` : ""}`;
    if (nextUrl === currentUrl) return;

    router.replace(nextUrl, { scroll: false });
  }, [appliedAsOfDate, pathname, router, searchParams]);

  const { data, error, isLoading, mutate, isValidating } = useSWR(
    dashboardUrl,
    fetcher,
    {
      refreshInterval: REFRESH_INTERVAL_MS,
      refreshWhenHidden: true,
      revalidateOnFocus: false,
      dedupingInterval: 10_000,
    },
  );

  useEffect(() => {
    let cancelled = false;

    async function loadProfiles() {
      try {
        const res = await fetch("/api/settings/agency-profiles", { cache: "no-store" });
        if (!res.ok) return;
        const body = await res.json() as { profiles?: AgencyProfile[] };
        if (!cancelled) setProfiles(body.profiles ?? []);
      } catch {
        if (!cancelled) setProfiles([]);
      }
    }

    loadProfiles();
    return () => { cancelled = true; };
  }, []);

  const activateProfile = useCallback(async () => {
    if (!selectedProfileId) return;
    setProfileSaving(true);
    setProfileError(null);
    try {
      const res = await fetch("/api/settings/agency-profiles/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: selectedProfileId, pin: profilePin }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setProfilePin("");
      await mutate(forceFetcher(dashboardUrl));
    } catch (profileActivateError) {
      setProfileError(profileActivateError instanceof Error ? profileActivateError.message : String(profileActivateError));
    } finally {
      setProfileSaving(false);
    }
  }, [dashboardUrl, mutate, profilePin, selectedProfileId]);

  const clearProfile = useCallback(async () => {
    setProfileSaving(true);
    setProfileError(null);
    try {
      const res = await fetch("/api/settings/agency-profiles/activate", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: profilePin }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setProfilePin("");
      setSelectedProfileId("");
      await mutate(forceFetcher(dashboardUrl));
    } catch (profileClearError) {
      setProfileError(profileClearError instanceof Error ? profileClearError.message : String(profileClearError));
    } finally {
      setProfileSaving(false);
    }
  }, [dashboardUrl, mutate, profilePin]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Appel avec ?refresh=1 pour invalider le cache serveur
      await mutate(forceFetcher(dashboardUrl));
    } finally {
      setRefreshing(false);
    }
  }, [dashboardUrl, mutate]);

  const handleFaitiereToggle = useCallback(async (includeCentralAgency: boolean) => {
    const currentSettings = data?.agencySettings;
    if (!currentSettings?.centralAgencyCode) return;
    if (currentSettings.consoMutuellesActive) return;

    setSavingFaitiere(true);
    setFaitiereError(null);
    try {
      const res = await fetch("/api/settings/agence-faitiere", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          centralAgencyCode: currentSettings.centralAgencyCode,
          includeCentralAgency,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await mutate(forceFetcher(dashboardUrl));
    } catch (toggleError) {
      setFaitiereError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setSavingFaitiere(false);
    }
  }, [dashboardUrl, data?.agencySettings, mutate]);

  /* ── Données dérivées ── */
  const ov = data?.overview;
  const totalLoan = ov?.totalLoanAmount ?? 0;
  const obj = data?.objectifs ?? {};
  const agencySettings = data?.agencySettings;
  const hasCentralAgency = Boolean(agencySettings?.centralAgencyCode);
  const consoMutuellesActive = Boolean(agencySettings?.consoMutuellesActive);
  const historyMaxDate = ov?.openDate ?? ov?.operationalDate ?? "";
  const historyDateInvalid = historicalEnabled && historicalDate !== "" && !normalizeHistoricalDate(historicalDate);
  const historyDateTooLate = Boolean(
    historicalEnabled && historicalDate && historyMaxDate && historicalDate > historyMaxDate,
  );
  const detailHref = useCallback(
    (href: string) => withAsOfDate(href, appliedAsOfDate),
    [appliedAsOfDate],
  );

  const liveStatus = isLoading || isValidating || refreshing || savingFaitiere ? "syncing" : error ? "error" : "";

  const parChartData = useMemo(() => [
    { name: "PAR 1J",  value: ov?.par1Amount  ?? 0, rate: ov?.par1Rate  ?? 0 },
    { name: "PAR 30J", value: ov?.par30Amount ?? 0, rate: ov?.par30Rate ?? 0 },
    { name: "PAR 90J", value: ov?.par90Amount ?? 0, rate: ov?.par90Rate ?? 0 },
  ], [ov]);

  const adherentTrend = data?.adherentTrend ?? [];
  const decaissTrend  = data?.decaissementTrend ?? [];
  const loanStatus    = data?.loanStatus ?? [];
  const agencies      = data?.agencyPerformance ?? [];

  /* ── Header ── */
  const header = (
    <header className="app-header">
      <AppBrandBlock sub="Tableau de Bord" />

      <div className="header-sep" />

      <div className="header-center">
        <div className="header-chip">
          <span className="chip-label">Période</span>
          <span className="chip-value accent">{ov?.periodLabel ?? "—"}</span>
        </div>
        <div className="header-sep" />
        <div className="header-chip">
          <span className="chip-label">Date d&apos;arrêt</span>
          <span className="chip-value">{ov?.operationalDate ?? "—"}</span>
        </div>
        <div className="header-sep" />
        <div className="header-chip">
          <span className="chip-label">Agences</span>
          <span className="chip-value">{ov ? num(ov.activeAgencies) : "—"}</span>
        </div>
      </div>

      <div className="header-actions">
        <label className={`history-toggle${historicalEnabled ? " active" : ""}`}>
          <input
            type="checkbox"
            checked={historicalEnabled}
            onChange={(event) => {
              const checked = event.target.checked;
              setHistoricalEnabled(checked);
              if (!checked) {
                setHistoricalDate("");
                return;
              }
              setHistoricalDate((current) => current || ov?.operationalDate || "");
            }}
          />
          <span>Historique</span>
          <small>{appliedAsOfDate ? appliedAsOfDate : "date courante"}</small>
        </label>
        {historicalEnabled && (
          <div className="history-date-box">
            <input
              type="date"
              value={historicalDate}
              max={historyMaxDate || undefined}
              onChange={(event) => setHistoricalDate(event.target.value)}
              aria-label="Date historique"
            />
            {(historyDateInvalid || historyDateTooLate) && (
              <small className="history-error">
                {historyDateTooLate ? `Max ${historyMaxDate}` : "Date invalide"}
              </small>
            )}
          </div>
        )}
        <div className={`faitiere-toggle${consoMutuellesActive ? " active" : ""}`} title="Profil de conso mutuelles du navigateur">
          <span>Conso mutuelles</span>
          <small>{agencySettings?.activeProfile?.name ?? "aucun profil"}</small>
          {!consoMutuellesActive && profiles.length > 0 && (
            <>
              <select
                value={selectedProfileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
                disabled={profileSaving}
                style={{ maxWidth: 150 }}
              >
                <option value="">Profil...</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
              <input
                type="password"
                value={profilePin}
                onChange={(event) => setProfilePin(event.target.value)}
                placeholder="PIN"
                disabled={profileSaving || !selectedProfileId}
                style={{ width: 76 }}
              />
              <button className="refresh-btn" type="button" onClick={activateProfile} disabled={profileSaving || !selectedProfileId}>
                OK
              </button>
            </>
          )}
          {consoMutuellesActive && (
            <>
              <input
                type="password"
                value={profilePin}
                onChange={(event) => setProfilePin(event.target.value)}
                placeholder="PIN"
                disabled={profileSaving}
                style={{ width: 76 }}
              />
              <button className="refresh-btn" type="button" onClick={clearProfile} disabled={profileSaving || !profilePin}>
                Desactiver
              </button>
            </>
          )}
        </div>
        <label
          className={`faitiere-toggle${hasCentralAgency && !consoMutuellesActive ? "" : " disabled"}`}
          title={consoMutuellesActive
            ? "Desactive car un profil de conso mutuelles limite deja le perimetre"
            : hasCentralAgency ? `Agence faitiere : ${agencySettings?.centralAgencyCode}` : "Definissez d'abord l'agence faitiere dans les parametres"}
        >
          <input
            type="checkbox"
            checked={consoMutuellesActive ? false : agencySettings?.includeCentralAgency ?? false}
            disabled={!hasCentralAgency || consoMutuellesActive || savingFaitiere || isLoading}
            onChange={(event) => handleFaitiereToggle(event.target.checked)}
          />
          <span>Integrer les donnees faitiere</span>
          <small>{consoMutuellesActive ? "grisee par profil" : agencySettings?.centralAgencyCode || "non definie"}</small>
        </label>
        <div className="live-indicator">
          <span className={`live-dot ${liveStatus}`} />
          <span>
            {ov?.asOf
              ? fmtDateTime.format(new Date(ov.asOf))
              : isLoading ? "Chargement…" : "—"}
          </span>
        </div>
        <button
          className="refresh-btn"
          onClick={handleRefresh}
          disabled={refreshing || isLoading}
          title="Rafraîchir maintenant (raccourci: R)"
          suppressHydrationWarning
        >
          <span className={`refresh-icon ${refreshing || isValidating ? "spin" : ""}`} suppressHydrationWarning>↻</span>
          Actualiser
        </button>
        {ov && (
          <button
            className="refresh-btn"
            title="Exporter le tableau de bord en Excel"
            onClick={() => exportDashboardToExcel({
              overview: { ...ov, totalSavingsAmount: ov.totalSavingsAmount ?? 0 },
              agencyPerformance: agencies,
              objectifs: obj,
              appName: branding.appName || "STATIS",
            })}
          >
            📥 Excel
          </button>
        )}
        <Link href="/parametrage/sql" className="settings-link" title="Parametrage">
          Parametrage
        </Link>
      </div>
    </header>
  );

  /* ── Error state ── */
  if (error && !isLoading) {
    return (
      <div className="app">
        {header}
        <div className="app-content">
          <div className="panel">
            <div className="error-panel">
              <div className="error-icon">⚠️</div>
              <div className="error-title">Connexion impossible à la base de données</div>
              <div className="error-detail">
                Vérifiez que SQL Server est démarré sur{" "}
                <code>localhost\SQL2022</code>, que le compte <code>sa</code> est activé,
                et que le service SQL Server Browser est en cours d&apos;exécution.
              </div>
              <div className="error-code">{String(error?.message ?? error)}</div>
              <button className="refresh-btn" onClick={handleRefresh}>
                <span className="refresh-icon">↻</span> Réessayer
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Loading state ── */
  if (isLoading && !data) {
    return (
      <div className="app">
        {header}
        <div className="app-content"><SkeletonDashboard /></div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════
     DASHBOARD PRINCIPAL
  ══════════════════════════════════════════════════════════ */
  return (
    <div className="app">
      {header}

      <div className="app-content fade-in">
        {faitiereError && <div className="settings-alert error">{faitiereError}</div>}
        {profileError && <div className="settings-alert error">{profileError}</div>}

        {/* ── SECTION 1 : KPIs Principaux ──────────────────── */}
        <div>
          <div className="section-head">
            <span className="section-title">Vue d&apos;ensemble</span>
            <span className="section-badge">Temps réel · 10 min</span>
          </div>
          <div className="kpi-grid">
            <KpiCard
              href={detailHref("/detail/adhesions")} slug="adhesions"
              label="Nouvelles Adhésions"
              value={num(ov?.newAdherentsPeriod)}
              detail={`${num(ov?.totalAdherents ?? 0)} membres au total`}
              sub={`Ce mois · ${ov?.periodLabel ?? "—"}`}
              icon="👥" topColor="var(--teal)" glowColor="var(--teal-soft)" iconBg="var(--teal-soft)"
              actual={ov?.newAdherentsPeriod ?? 0} objectif={obj["adhesions"]} unit="count"
            />
            <KpiCard
              href={detailHref("/detail/encours-credit")} slug="encours-credit"
              label="Encours Crédit"
              value={cur(ov?.totalLoanAmount)}
              detail="Portefeuille net à la date d'arrêt"
              icon="🏦" topColor="var(--blue)" glowColor="var(--blue-soft)" iconBg="var(--blue-soft)"
              actual={ov?.totalLoanAmount ?? 0} objectif={obj["encours-credit"]}
            />
            <KpiCard
              href={detailHref("/detail/encours-epargne")} slug="encours-epargne"
              label="Encours Épargne"
              value={ov?.totalSavingsAmount == null ? "A calculer" : cur(ov.totalSavingsAmount)}
              detail={ov?.savingsSnapshotPeriod ? `HDPM au ${ov.savingsSnapshotPeriod}` : "Calcul detaille hors chargement initial"}
              icon="💰" topColor="var(--green)" glowColor="var(--green-soft)" iconBg="var(--green-soft)"
              actual={ov?.totalSavingsAmount ?? 0} objectif={obj["encours-epargne"]}
            />
            <KpiCard
              href={detailHref("/detail/resultat")} slug="resultat"
              label="Résultat"
              value={cur(ov?.totalResult)}
              detail="Classe 7 - Classe 6"
              sub="Exercice en cours via HDPM"
              icon="📈" topColor="var(--purple)" glowColor="var(--purple-soft)" iconBg="var(--purple-soft)"
              actual={ov?.totalResult ?? 0} objectif={obj["resultat"]}
            />
          </div>
        </div>

        {/* ── SECTION 2 : Qualité du Portefeuille ─────────── */}
        <div>
          <div className="section-head">
            <span className="section-title">Qualité du Portefeuille</span>
            <span className="section-badge">PAR — Portfolio at Risk</span>
          </div>
          <div className="par-grid">
            <ParCard href="/detail/par-1j"  slug="par-1j"  label="PAR à 1 Jour"   rate={ov?.par1Rate  ?? 0} amount={ov?.par1Amount  ?? 0} totalLoan={totalLoan} objectif={obj["par-1j"]} />
            <ParCard href="/detail/par-30j" slug="par-30j" label="PAR à 30 Jours" rate={ov?.par30Rate ?? 0} amount={ov?.par30Amount ?? 0} totalLoan={totalLoan} objectif={obj["par-30j"]} />
            <ParCard href="/detail/par-90j" slug="par-90j" label="PAR à 90 Jours" rate={ov?.par90Rate ?? 0} amount={ov?.par90Amount ?? 0} totalLoan={totalLoan} objectif={obj["par-90j"]} />
          </div>
        </div>

        {/* ── SECTION 3 : Activité Opérationnelle ──────────── */}
        <div>
          <div className="section-head">
            <span className="section-title">Activité Opérationnelle</span>
            <span className="section-badge">Mois en cours · {ov?.periodLabel ?? "—"}</span>
          </div>
          <div className="ops-grid">
            <OpsCard
              href="/detail/decaissements" slug="decaissements"
              label="Décaissements"
              value={cur(ov?.decaissementsPeriod)}
              detail={`${num(ov?.decaissementsCount ?? 0)} opération(s)`}
              icon="💸" bg="var(--blue-soft)" color="var(--blue)"
              actual={ov?.decaissementsPeriod ?? 0} objectif={obj["decaissements"]}
            />
            <OpsCard
              href="/detail/tontine-collecte" slug="tontine-collecte"
              label="Collecte Tontine"
              value={cur(ov?.tontineCollectionPeriod)}
              detail={`${num(ov?.tontineDepositsCount ?? 0)} versement(s)`}
              icon="🤝" bg="var(--teal-soft)" color="var(--teal)"
              actual={ov?.tontineCollectionPeriod ?? 0} objectif={obj["tontine-collecte"]}
            />
            <OpsCard
              href="/detail/souscriptions-tontine" slug="souscriptions-tontine"
              label="Souscriptions Tontine"
              value={num(ov?.tontineSubscriptionsPeriod)}
              detail="Nouvelles souscriptions tontine"
              icon="📋" bg="var(--purple-soft)" color="var(--purple)"
              actual={ov?.tontineSubscriptionsPeriod ?? 0} objectif={obj["souscriptions-tontine"]}
              unit="count"
            />
            <OpsCard
              href="/detail/impayes" slug="impayes"
              label="Impayés"
              value={cur(ov?.totalImpayes)}
              detail="Échéances dues non soldées"
              icon="⚠️" bg="var(--amber-soft)" color="var(--amber)"
              actual={ov?.totalImpayes ?? 0} objectif={obj["impayes"]}
            />
            <OpsCard
              href="/detail/stock-perte" slug="stock-perte"
              label="Stock Crédit en Perte"
              value={cur(ov?.stockCreditLoss)}
              detail="Stock net DECLAS_HIST - recouvrements"
              icon="📉" bg="var(--red-soft)" color="var(--red)"
              actual={ov?.stockCreditLoss ?? 0} objectif={obj["stock-perte"]}
            />
            <OpsCard
              href="/detail/transfere-perte" slug="transfere-perte"
              label="Transféré en Perte"
              value={cur(ov?.creditTransferredToLossPeriod)}
              detail={`${num(ov?.creditTransferredToLossCount ?? 0)} dossier(s) ce mois`}
              icon="↘️" bg="var(--red-soft)" color="var(--red)"
              actual={ov?.creditTransferredToLossPeriod ?? 0} objectif={obj["transfere-perte"]}
            />
            <OpsCard
              href="/detail/recouvrement" slug="recouvrement"
              label="Recouvrement"
              value={cur(ov?.creditRecoveryPeriod)}
              detail={`${num(ov?.creditRecoveryCount ?? 0)} opération(s) ce mois`}
              icon="↗️" bg="var(--green-soft)" color="var(--green)"
              actual={ov?.creditRecoveryPeriod ?? 0} objectif={obj["recouvrement"]}
            />
            <CashOpsCard
              href="/detail/operations-caisse"
              cashIn={ov?.cashInAmount ?? 0}
              cashOut={ov?.cashOutAmount ?? 0}
              count={ov?.cashOperationsCount ?? 0}
              objectif={obj["operations-caisse"]}
            />
            <MobileMoneyCard
              href="/detail/mobile-money"
              deposits={ov?.mobileMoneyDepositAmount ?? 0}
              withdrawals={ov?.mobileMoneyWithdrawalAmount ?? 0}
              count={ov?.mobileMoneyOperationsCount ?? 0}
              objectif={obj["mobile-money"]}
            />
            <TreasuryCard
              href="/detail/tresorerie"
              cash={ov?.treasuryCashAmount ?? 0}
              bank={ov?.treasuryBankAmount ?? 0}
              objectif={obj["tresorerie"]}
            />
          </div>
        </div>

        {/* ── SECTION 4 : Graphiques Tendances ─────────────── */}
        <div>
          <div className="section-head">
            <span className="section-title">Évolution</span>
          </div>
          <div className="charts-row">

            {/* Adhésions 12 mois */}
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">Croissance</div>
                  <div className="panel-title">Adhésions sur 12 mois</div>
                </div>
              </div>
              <div className="panel-body">
                <div className="chart-inner">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={adherentTrend} margin={{ left: 0, right: 0 }}>
                      <defs>
                        <linearGradient id="gradAdh" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="var(--teal)" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="var(--teal)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tickFormatter={shortMonth}
                        tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                        axisLine={false} tickLine={false}
                      />
                      <YAxis
                        tickFormatter={v => cpt(Number(v))}
                        tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                        axisLine={false} tickLine={false} width={48}
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Area
                        type="monotone" dataKey="total"
                        stroke="var(--teal)" strokeWidth={2.5}
                        fill="url(#gradAdh)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Décaissements 6 mois */}
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">Flux de crédit</div>
                  <div className="panel-title">Décaissements sur 6 mois</div>
                </div>
              </div>
              <div className="panel-body">
                <div className="chart-inner">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={decaissTrend} margin={{ left: 0, right: 0 }}>
                      <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tickFormatter={shortMonth}
                        tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                        axisLine={false} tickLine={false}
                      />
                      <YAxis
                        tickFormatter={v => cpt(Number(v))}
                        tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                        axisLine={false} tickLine={false} width={56}
                      />
                      <Tooltip content={<CurrencyTooltip />} />
                      <Bar dataKey="total" fill="var(--blue)" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── SECTION 5 : PAR Comparatif + Portefeuille ────── */}
        <div>
          <div className="section-head">
            <span className="section-title">Analyse du Portefeuille</span>
          </div>
          <div className="charts-row">

            {/* Comparatif PAR montants */}
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">Risque</div>
                  <div className="panel-title">Comparatif PAR — Montants à risque</div>
                </div>
              </div>
              <div className="panel-body">
                <div className="chart-inner">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={parChartData} margin={{ left: 0, right: 0 }}>
                      <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                      <XAxis
                        dataKey="name"
                        tick={{ fill: "#5d4349", fontSize: 12, fontWeight: 700 }}
                        axisLine={false} tickLine={false}
                      />
                      <YAxis
                        tickFormatter={v => cpt(Number(v))}
                        tick={{ fill: "#73585e", fontSize: 11, fontWeight: 600 }}
                        axisLine={false} tickLine={false} width={60}
                      />
                      <Tooltip content={<CurrencyTooltip />} />
                      <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                        {parChartData.map((entry) => (
                          <Cell
                            key={entry.name}
                            fill={
                              riskLevel(entry.rate) === "faible" ? "var(--teal)"
                              : riskLevel(entry.rate) === "modéré" ? "var(--amber)"
                              : "var(--red)"
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Donut répartition statuts prêts */}
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">Structure</div>
                  <div className="panel-title">Répartition par statut de prêt</div>
                </div>
              </div>
              <div className="panel-body">
                <div className="chart-inner" style={{ position: "relative" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={loanStatus}
                        dataKey="totalLoans"
                        nameKey="statusCode"
                        innerRadius="55%"
                        outerRadius="80%"
                        paddingAngle={3}
                        startAngle={90}
                        endAngle={-270}
                      >
                        {loanStatus.map((entry) => (
                          <Cell
                            key={entry.statusCode}
                            fill={LOAN_STATUS_COLORS[entry.statusCode] ?? "var(--text-dim)"}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: ValueType | undefined) => [
                          `${num(toNumber(value))} dossiers`,
                          "",
                        ]}
                        contentStyle={{
                          background: "var(--surface-4)",
                          border: "1px solid var(--border-md)",
                          borderRadius: 10,
                          fontSize: 12,
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="legend-strip">
                  {loanStatus.map((entry) => (
                    <div key={entry.statusCode} className="legend-item">
                      <span className="legend-dot" style={{ background: LOAN_STATUS_COLORS[entry.statusCode] ?? "var(--text-dim)" }} />
                      {LOAN_STATUS_LABELS[entry.statusCode] ?? entry.statusCode}
                      <span style={{ color: "var(--text-2)", fontWeight: 600, marginLeft: 4 }}>
                        {num(entry.totalLoans)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── SECTION 6 : Performance par Agence ───────────── */}
        <div>
          <div className="section-head">
            <span className="section-title">Performance par Agence</span>
          </div>
          <div className="panel">
            <div className="agency-row">

              {/* Barchart horizontal */}
              <div className="agency-chart-wrap">
                <div className="panel-kicker">Adhérents par agence</div>
                <div className="panel-title" style={{ marginBottom: 0 }}>Top agences</div>
                <div className="agency-chart-inner">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={agencies.slice(0, 8)}
                      layout="vertical"
                      margin={{ left: 8, right: 8 }}
                    >
                      <CartesianGrid stroke="rgba(122,31,43,0.10)" horizontal={false} />
                      <XAxis
                        type="number"
                        tickFormatter={v => cpt(Number(v))}
                        tick={{ fill: "#73585e", fontSize: 10, fontWeight: 600 }}
                        axisLine={false} tickLine={false}
                      />
                      <YAxis
                        dataKey="agencyName"
                        type="category"
                        width={128}
                        tick={{ fill: "#5d4349", fontSize: 12, fontWeight: 700 }}
                        axisLine={false} tickLine={false}
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="adherents" radius={[0, 6, 6, 0]}>
                        {agencies.slice(0, 8).map((_, i) => (
                          <Cell
                            key={i}
                            fill={["#7a1f2b", "#8e2636", "#a83246", "#b94b59", "#c96d60", "#d78b1f", "#3f7fa4", "#8d5a8f"][i] ?? "#7a1f2b"}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Table */}
              <div className="agency-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Agence</th>
                      <th>Adhérents</th>
                      <th>Prêts actifs</th>
                      <th>Encours crédit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agencies.map((ag, i) => (
                      <tr key={ag.agencyCode}>
                        <td>
                          <span className={`rank-chip${i < 3 ? ` top-${i + 1}` : ""}`}>{i + 1}</span>
                        </td>
                        <td>
                          <div className="td-agency">
                            <strong>{ag.agencyName}</strong>
                            <span>{ag.agencyCode}</span>
                          </div>
                        </td>
                        <td className="td-num">{num(ag.adherents)}</td>
                        <td className="td-num">{num(ag.loans)}</td>
                        <td className="td-amount">{cur(ag.loanAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

            </div>
          </div>
        </div>

      </div>{/* /app-content */}

      <footer className="app-footer">
        <span>BASE_INTERCO · Dashboard temps réel</span>
        <span className="footer-dot" />
        <span>Données issues de SQL Server <code>localhost\SQL2022</code></span>
        <span className="footer-dot" />
        <span>Rafraîchissement automatique toutes les 10 minutes</span>
        <span className="footer-dot" />
        <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>
          Règles PAR et encours conformes à perfect-indicateurs.md
        </span>
      </footer>
    </div>
  );
}
