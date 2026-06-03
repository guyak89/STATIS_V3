/**
 * lib/excel-export.ts
 * Export Excel mis en forme (exceljs) pour toutes les pages du tableau de bord.
 * Toutes les fonctions sont async et doivent être appelées depuis un onClick.
 */

import ExcelJS from "exceljs";

/* ═══════════════════════════════════════════════════════════════
   THÈME COULEURS (bordeaux de l'application)
═══════════════════════════════════════════════════════════════ */
const C = {
  headerBg:   "7A1F2B", // bordeaux — fond en-tête colonnes
  headerFg:   "FFFFFF", // blanc — texte en-tête
  titleFg:    "3D0F17", // bordeaux foncé — titres
  subtitleFg: "5D4349", // bordeaux moyen — sous-titres
  totalBg:    "F0D5D9", // rose pâle — ligne total
  totalFg:    "5D1020", // bordeaux — texte total
  altBg:      "FBF4F5", // alternance légère des lignes
  sectionBg:  "F5E3E6", // séparateur de section
  borderLight:"E0B8BE", // bordure douce
  borderDark: "5D1020", // bordure forte
} as const;

/* ═══════════════════════════════════════════════════════════════
   FORMATS NUMÉRIQUES
═══════════════════════════════════════════════════════════════ */
const FMT_MONEY = '#,##0';
const FMT_PCT   = '0.00"%"';
const FMT_INT   = '#,##0';

function solidFill(hex: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + hex } };
}

function thinBorder(color: string = C.borderLight): ExcelJS.Border {
  return { style: "thin", color: { argb: "FF" + color } };
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS DE MISE EN FORME
═══════════════════════════════════════════════════════════════ */

/** Ligne d'en-tête colonnes : fond bordeaux, texte blanc gras */
function styleHeaderRow(row: ExcelJS.Row, colCount: number): void {
  row.height = 30;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font      = { bold: true, color: { argb: "FF" + C.headerFg }, size: 10, name: "Calibri" };
    cell.fill      = solidFill(C.headerBg);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: false };
    cell.border    = {
      bottom: { style: "medium", color: { argb: "FF" + C.headerBg } },
      right:  thinBorder(C.headerBg),
    };
  }
}

/** Ligne titre principal */
function styleTitleRow(row: ExcelJS.Row, size = 14): void {
  row.height = size === 14 ? 28 : 22;
  row.getCell(1).font      = { bold: true, size, color: { argb: "FF" + C.titleFg }, name: "Calibri" };
  row.getCell(1).alignment = { vertical: "middle" };
}

/** Ligne sous-titre / métadonnées */
function styleMetaRow(row: ExcelJS.Row): void {
  row.height = 18;
  row.getCell(1).font      = { italic: true, size: 9, color: { argb: "FF" + C.subtitleFg }, name: "Calibri" };
  row.getCell(1).alignment = { vertical: "middle" };
}

/** Ligne séparateur de section */
function styleSectionRow(row: ExcelJS.Row, colCount: number): void {
  row.height = 20;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill      = solidFill(C.sectionBg);
    cell.font      = { bold: true, italic: true, size: 9, color: { argb: "FF" + C.titleFg }, name: "Calibri" };
    if (c === 1) cell.alignment = { vertical: "middle" };
  }
}

/** Ligne de total */
function styleTotalRow(row: ExcelJS.Row, colCount: number): void {
  row.height = 24;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill      = solidFill(C.totalBg);
    cell.font      = { bold: true, size: 10, color: { argb: "FF" + C.totalFg }, name: "Calibri" };
    cell.border    = { top: { style: "medium", color: { argb: "FF" + C.headerBg } } };
    if (c > 1 && typeof cell.value === "number") {
      cell.alignment = { horizontal: "right" };
    }
  }
}

/** Alternance couleur sur les lignes de données */
function styleDataRow(row: ExcelJS.Row, colCount: number, even: boolean): void {
  row.height = 18;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    if (even) cell.fill = solidFill(C.altBg);
    cell.border = { bottom: thinBorder(C.borderLight) };
    if (c > 1 && typeof cell.value === "number") {
      cell.alignment = { horizontal: "right", vertical: "middle" };
    } else {
      cell.alignment = { vertical: "middle" };
    }
    cell.font = { size: 10, name: "Calibri" };
  }
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS COMMUNES
═══════════════════════════════════════════════════════════════ */

function nowFR(): string {
  return new Date().toLocaleDateString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

async function triggerDownload(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  const buf  = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Initialise le classeur avec les métadonnées de l'application */
function createWorkbook(appName: string): ExcelJS.Workbook {
  const wb      = new ExcelJS.Workbook();
  wb.creator    = appName;
  wb.created    = new Date();
  wb.properties.date1904 = false;
  return wb;
}

/** Ajoute les 3 lignes de titre + 1 ligne vide, retourne le prochain numéro de ligne */
function addTitleBlock(
  ws: ExcelJS.Worksheet,
  title: string,
  subtitle: string,
  appName: string,
): number {
  const r1 = ws.addRow([appName]);
  styleTitleRow(r1, 12);

  const r2 = ws.addRow([title]);
  styleTitleRow(r2, 14);

  const r3 = ws.addRow([subtitle]);
  styleMetaRow(r3);

  ws.addRow([]);           // ligne vide

  return 5; // la prochaine ligne disponible = 5
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 1 — Pages de détail indicateur (14 indicateurs)
═══════════════════════════════════════════════════════════════ */

export type DetailExportRow = {
  agencyCode: string;
  agencyName: string;
  valeur: number;
  count?: number;
  rate?: number;
  totalPortfolio?: number;
  totalStock?: number;
  objectif?: number | null;
};

export type DetailExportParams = {
  indicator: string;
  label: string;
  unit: "currency" | "count" | "percent";
  hasRate: boolean;
  total: number;
  rows: DetailExportRow[];
  objectifGlobal: number | null;
  lowerIsBetter: boolean;
  appName: string;
};

export async function exportDetailToExcel(p: DetailExportParams): Promise<void> {
  const isAdhesions = p.indicator === "adhesions";
  const hasCnt      = !isAdhesions && (p.rows[0]?.count !== undefined);
  const hasObj      = p.rows.some(r => r.objectif != null) || p.objectifGlobal != null;
  const period      = new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" });

  const fmt = p.unit === "currency" ? FMT_MONEY : p.unit === "percent" ? FMT_PCT : FMT_INT;
  const unitLabel = p.unit === "currency" ? " (XOF)" : p.unit === "percent" ? " (%)" : "";

  /* ── Colonnes ── */
  type ColDef = { header: string; key: string; width: number; numFmt?: string; align?: "right" | "left" | "center" };
  const cols: ColDef[] = [
    { header: "Rang",               key: "rang",    width: 6,  align: "center" },
    { header: "Code",               key: "code",    width: 8 },
    { header: "Mutuelle / Agence",  key: "agence",  width: 34 },
    { header: p.label + unitLabel,  key: "valeur",  width: 22, numFmt: fmt, align: "right" },
  ];
  if (isAdhesions)   cols.push({ header: "Stock total membres", key: "stock",    width: 20, numFmt: FMT_INT,   align: "right" });
  if (p.hasRate)   { cols.push({ header: "Taux PAR (%)",        key: "rate",     width: 14, numFmt: FMT_PCT,   align: "right" });
                     cols.push({ header: "Encours total (XOF)", key: "portfolio",width: 22, numFmt: FMT_MONEY, align: "right" }); }
  if (hasCnt)        cols.push({ header: "Nb opérations",       key: "count",    width: 14, numFmt: FMT_INT,   align: "right" });
  cols.push(          { header: "Part du total (%)",            key: "share",    width: 16, numFmt: FMT_PCT,   align: "right" });
  if (hasObj)      { cols.push({ header: "Objectif" + unitLabel,key: "objectif", width: 22, numFmt: fmt,       align: "right" });
                     cols.push({ header: "Réalisation (%)",      key: "realisa",  width: 16, numFmt: FMT_PCT,   align: "right" }); }

  const nb = cols.length;

  /* ── Classeur ── */
  const wb = createWorkbook(p.appName);
  const ws = wb.addWorksheet("Détail");

  ws.columns = cols.map(c => ({
    key: c.key, width: c.width,
    style: c.numFmt
      ? { numFmt: c.numFmt, alignment: { horizontal: c.align ?? "left" } }
      : { alignment: { horizontal: c.align ?? "left" } },
  }));

  /* Bloc titre */
  addTitleBlock(
    ws,
    p.label + " — Détail par Agence / Mutuelle",
    `Période : ${period}   —   Généré le ${nowFR()}`,
    p.appName,
  );

  /* En-tête colonnes */
  const headerRow = ws.addRow(cols.map(c => c.header));
  styleHeaderRow(headerRow, nb);

  /* Données */
  const sorted = [...p.rows].sort((a, b) => b.valeur - a.valeur);
  sorted.forEach((row, i) => {
    const share   = p.total > 0 ? (row.valeur / p.total) * 100 : 0;
    const agObj   = row.objectif ?? p.objectifGlobal;
    const rowData: Record<string, string | number> = {
      rang:   i + 1,
      code:   row.agencyCode,
      agence: row.agencyName,
      valeur: row.valeur,
    };
    if (isAdhesions)   rowData.stock     = row.totalStock ?? 0;
    if (p.hasRate)   { rowData.rate      = row.rate ?? 0;
                       rowData.portfolio = row.totalPortfolio ?? 0; }
    if (hasCnt)        rowData.count     = row.count ?? 0;
    rowData.share = share;
    if (hasObj)      { rowData.objectif  = agObj ?? 0;
                       rowData.realisa   = agObj && agObj > 0 ? (row.valeur / agObj) * 100 : 0; }

    const dr = ws.addRow(rowData);
    styleDataRow(dr, nb, i % 2 === 1);
  });

  /* Ligne TOTAL */
  const totData: Record<string, string | number> = {
    rang: "", code: "", agence: "TOTAL", valeur: p.total,
  };
  if (isAdhesions)   totData.stock     = sorted.reduce((s, r) => s + (r.totalStock ?? 0), 0);
  if (p.hasRate)   { totData.rate      = 0; totData.portfolio = sorted.reduce((s, r) => s + (r.totalPortfolio ?? 0), 0); }
  if (hasCnt)        totData.count     = sorted.reduce((s, r) => s + (r.count ?? 0), 0);
  totData.share = 100;
  if (hasObj)      { totData.objectif  = p.objectifGlobal ?? 0; totData.realisa = 0; }

  const totalRow = ws.addRow(totData);
  styleTotalRow(totalRow, nb);

  /* Gel volets */
  ws.views = [{ state: "frozen", ySplit: 5, xSplit: 0 }];

  /* Largeur colonne "agence" = auto-wrap */
  ws.getColumn("agence").alignment = { wrapText: false, vertical: "middle" };

  await triggerDownload(wb, `${p.indicator}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 2 — Dashboard principal (2 feuilles)
═══════════════════════════════════════════════════════════════ */

export type DashboardOverview = {
  periodLabel: string;
  operationalDate: string;
  totalAdherents: number;
  newAdherentsPeriod: number;
  activeAgencies: number;
  totalLoanAmount: number;
  totalSavingsAmount: number;
  par1Rate: number; par30Rate: number; par90Rate: number;
  par1Amount: number; par30Amount: number; par90Amount: number;
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
  mobileMoneyDepositAmount: number;
  mobileMoneyWithdrawalAmount: number;
  mobileMoneyOperationsCount: number;
  treasuryCashAmount: number;
  treasuryBankAmount: number;
  treasuryTotalAmount: number;
};

export type AgencyPerfExport = {
  agencyCode: string;
  agencyName: string;
  adherents: number;
  loans: number;
  loanAmount: number;
};

export async function exportDashboardToExcel(params: {
  overview: DashboardOverview;
  agencyPerformance: AgencyPerfExport[];
  objectifs: Record<string, number>;
  appName: string;
}): Promise<void> {
  const { overview: ov, agencyPerformance: ag, objectifs: obj, appName } = params;
  const wb = createWorkbook(appName);

  /* ── Feuille 1 : KPIs ── */
  const wsKpi = wb.addWorksheet("KPIs Principaux");
  wsKpi.columns = [
    { key: "indicateur", width: 42 },
    { key: "valeur",     width: 24 },
    { key: "unite",      width: 14 },
    { key: "objectif",   width: 24 },
    { key: "realisa",    width: 18, style: { numFmt: FMT_PCT, alignment: { horizontal: "right" } } },
  ];

  addTitleBlock(
    wsKpi,
    "Tableau de Bord — Synthèse des Indicateurs Clés",
    `Période : ${ov.periodLabel}   —   Date d'arrêt : ${ov.operationalDate}   —   Généré le ${nowFR()}`,
    appName,
  );

  const kpiHeader = wsKpi.addRow(["INDICATEUR", "VALEUR", "UNITÉ", "OBJECTIF", "RÉALISATION (%)"]);
  styleHeaderRow(kpiHeader, 5);
  wsKpi.views = [{ state: "frozen", ySplit: 5 }];

  function addKpi(
    label: string, val: number, unite: string,
    fmt: string, slug?: string,
  ) {
    const o   = slug ? obj[slug] : undefined;
    const row = wsKpi.addRow({
      indicateur: label,
      valeur:     val,
      unite,
      objectif:   o ?? null,
      realisa:    o && o > 0 ? (val / o) * 100 : null,
    });
    row.height = 20;
    row.getCell(2).numFmt = fmt;
    if (o) row.getCell(4).numFmt = fmt;
    row.getCell(1).font = { size: 10, name: "Calibri" };
    row.getCell(2).alignment = { horizontal: "right" };
    row.getCell(4).alignment = { horizontal: "right" };
    return row;
  }

  function addSection(label: string) {
    const r = wsKpi.addRow([label]);
    styleSectionRow(r, 5);
  }

  function addEmpty() { wsKpi.addRow([]); }

  addSection("Membres");
  addKpi("Nouvelles Adhésions (mois)",        ov.newAdherentsPeriod,            "membres",       FMT_INT,   "adhesions");
  addKpi("Total Adhérents (stock cumulé)",    ov.totalAdherents,                "membres",       FMT_INT);
  addKpi("Agences actives",                   ov.activeAgencies,                "agences",       FMT_INT);
  addEmpty();

  addSection("Encours");
  addKpi("Encours Crédit",                    ov.totalLoanAmount,               "XOF",           FMT_MONEY, "encours-credit");
  addKpi("Encours Épargne",                   ov.totalSavingsAmount,            "XOF",           FMT_MONEY, "encours-epargne");
  addKpi("Résultat",                          ov.totalResult,                   "XOF",           FMT_MONEY, "resultat");
  addEmpty();

  addSection("Qualité Portefeuille (PAR)");
  addKpi("PAR à 1 Jour — Montant",            ov.par1Amount,                    "XOF",           FMT_MONEY);
  addKpi("PAR à 1 Jour — Taux",               ov.par1Rate,                      "%",             FMT_PCT,   "par-1j");
  addKpi("PAR à 30 Jours — Montant",          ov.par30Amount,                   "XOF",           FMT_MONEY);
  addKpi("PAR à 30 Jours — Taux",             ov.par30Rate,                     "%",             FMT_PCT,   "par-30j");
  addKpi("PAR à 90 Jours — Montant",          ov.par90Amount,                   "XOF",           FMT_MONEY);
  addKpi("PAR à 90 Jours — Taux",             ov.par90Rate,                     "%",             FMT_PCT,   "par-90j");
  addEmpty();

  addSection("Activité Opérationnelle (mois)");
  addKpi("Décaissements",                     ov.decaissementsPeriod,           "XOF",           FMT_MONEY, "decaissements");
  addKpi("Décaissements — Nb dossiers",       ov.decaissementsCount,            "dossiers",      FMT_INT);
  addKpi("Collecte Tontine",                  ov.tontineCollectionPeriod,       "XOF",           FMT_MONEY, "tontine-collecte");
  addKpi("Souscriptions Tontine",             ov.tontineSubscriptionsPeriod,    "souscriptions", FMT_INT,   "souscriptions-tontine");
  addEmpty();

  addSection("Risque & Recouvrement");
  addKpi("Impayés (total)",                   ov.totalImpayes,                  "XOF",           FMT_MONEY, "impayes");
  addKpi("Stock Crédit en Perte",             ov.stockCreditLoss,               "XOF",           FMT_MONEY, "stock-perte");
  addKpi("Transféré en Perte (mois)",         ov.creditTransferredToLossPeriod, "XOF",           FMT_MONEY);
  addKpi("Transféré en Perte — Nb dossiers",  ov.creditTransferredToLossCount,  "dossiers",      FMT_INT);
  addKpi("Recouvrement (mois)",               ov.creditRecoveryPeriod,          "XOF",           FMT_MONEY);
  addKpi("Recouvrement — Nb opérations",      ov.creditRecoveryCount,           "opérations",    FMT_INT);
  addKpi("Mobile Money — Dépôts",             ov.mobileMoneyDepositAmount,      "XOF",           FMT_MONEY, "mobile-money");
  addKpi("Mobile Money — Retraits",           ov.mobileMoneyWithdrawalAmount,   "XOF",           FMT_MONEY);
  addKpi("Mobile Money — Nb opérations",      ov.mobileMoneyOperationsCount,    "opérations",    FMT_INT);
  addKpi("Trésorerie",                        ov.treasuryTotalAmount,           "XOF",           FMT_MONEY, "tresorerie");
  addKpi("Trésorerie — Caisses",              ov.treasuryCashAmount,            "XOF",           FMT_MONEY);
  addKpi("Trésorerie — Banques",              ov.treasuryBankAmount,            "XOF",           FMT_MONEY);

  /* ── Feuille 2 : Agences ── */
  const wsAg = wb.addWorksheet("Performance Agences");
  wsAg.columns = [
    { key: "rang",   width: 6 },
    { key: "code",   width: 8 },
    { key: "agence", width: 34 },
    { key: "adh",    width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "right" } } },
    { key: "prets",  width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "right" } } },
    { key: "encours",width: 24, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
  ];

  addTitleBlock(
    wsAg,
    "Performance par Agence / Mutuelle",
    `Période : ${ov.periodLabel}   —   Date d'arrêt : ${ov.operationalDate}   —   Généré le ${nowFR()}`,
    appName,
  );

  const agHeader = wsAg.addRow(["Rang", "Code", "Mutuelle / Agence", "Adhérents", "Prêts actifs", "Encours Crédit (XOF)"]);
  styleHeaderRow(agHeader, 6);
  wsAg.views = [{ state: "frozen", ySplit: 5 }];

  ag.forEach((a, i) => {
    const dr = wsAg.addRow({ rang: i + 1, code: a.agencyCode, agence: a.agencyName, adh: a.adherents, prets: a.loans, encours: a.loanAmount });
    styleDataRow(dr, 6, i % 2 === 1);
  });

  const totAg = wsAg.addRow({
    rang: "", code: "", agence: "TOTAL",
    adh:     ag.reduce((s, a) => s + a.adherents, 0),
    prets:   ag.reduce((s, a) => s + a.loans,     0),
    encours: ag.reduce((s, a) => s + a.loanAmount, 0),
  });
  styleTotalRow(totAg, 6);

  await triggerDownload(wb, `dashboard_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 3 — Rapport Impayés
═══════════════════════════════════════════════════════════════ */

export type ImpayesDossierExport = {
  NUM_DOSSIER: string;
  nom: string;
  prenom: string;
  premiereEcheanceImpayee: string;
  derniereEcheanceImpayee: string;
  joursRetard: number;
  nbEcheancesImpayees: number;
  capitalImpaye: number;
  interetImpaye: number;
  epargneImpayee: number;
  commissionImpayee: number;
  totalImpaye: number;
  montantPretInitial: number;
  capitalRestantDu: number;
  etatPret: string;
};

function tranche(j: number): string {
  if (j <= 30)  return "≤ 30 j";
  if (j <= 90)  return "31–90 j";
  if (j <= 180) return "91–180 j";
  return "> 180 j";
}

export async function exportImpayesToExcel(params: {
  agenceCode: string;
  agenceNom: string;
  dateArret: string;
  totalDossiers: number;
  totalImpaye: number;
  totalCapital: number;
  totalInteret: number;
  totalRestantDu: number;
  maxJoursRetard: number;
  dossiers: ImpayesDossierExport[];
  appName: string;
}): Promise<void> {
  const { dossiers, agenceCode, agenceNom, dateArret, appName } = params;
  const wb = createWorkbook(appName);
  const ws = wb.addWorksheet(`Impayés ${agenceCode}`);

  ws.columns = [
    { key: "n",          width: 5 },
    { key: "dossier",    width: 20 },
    { key: "nom",        width: 28 },
    { key: "premEch",    width: 14 },
    { key: "dernEch",    width: 14 },
    { key: "jours",      width: 13, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
    { key: "nbEch",      width: 12, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
    { key: "capital",    width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "interet",    width: 18, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "total",      width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "pretInit",   width: 20, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "restantDu",  width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "etat",       width: 9 },
    { key: "tranche",    width: 12 },
  ];

  const nb = 14;

  /* Titre */
  addTitleBlock(
    ws,
    `Rapport Impayés — Agence ${agenceCode} : ${agenceNom}`,
    `Date d'arrêt : ${dateArret}   —   Généré le ${nowFR()}`,
    appName,
  );

  /* Bloc synthèse (4 lignes avant l'en-tête) */
  const s1 = ws.addRow({ n: "Dossiers en impayé", dossier: params.totalDossiers, nom: "", premEch: "Capital impayé (XOF)", dernEch: params.totalCapital });
  s1.getCell(2).numFmt = FMT_INT;
  s1.getCell(5).numFmt = FMT_MONEY;
  s1.height = 18;

  const s2 = ws.addRow({ n: "Montant impayé (XOF)", dossier: params.totalImpaye, nom: "", premEch: "Capital restant dû (XOF)", dernEch: params.totalRestantDu });
  s2.getCell(2).numFmt = FMT_MONEY;
  s2.getCell(5).numFmt = FMT_MONEY;
  s2.height = 18;

  const s3 = ws.addRow({ n: "Retard maximum (j)", dossier: params.maxJoursRetard, nom: "", premEch: "Intérêts impayés (XOF)", dernEch: params.totalInteret });
  s3.getCell(2).numFmt = FMT_INT;
  s3.getCell(5).numFmt = FMT_MONEY;
  s3.height = 18;

  [s1, s2, s3].forEach(r => {
    r.getCell(1).font = { bold: true, size: 9, color: { argb: "FF" + C.subtitleFg }, name: "Calibri" };
    r.getCell(4).font = { bold: true, size: 9, color: { argb: "FF" + C.subtitleFg }, name: "Calibri" };
    r.getCell(2).font = { bold: true, size: 10, color: { argb: "FF" + C.titleFg }, name: "Calibri" };
    r.getCell(5).font = { bold: true, size: 10, color: { argb: "FF" + C.titleFg }, name: "Calibri" };
  });

  ws.addRow([]);

  /* En-tête colonnes */
  const headerRow = ws.addRow([
    "N°", "Num. Dossier", "Nom / Prénom",
    "1ère échéance", "Dernière échéance",
    "Jours retard", "Nb échéances",
    "Capital impayé (XOF)", "Intérêts (XOF)", "Total impayé (XOF)",
    "Prêt initial (XOF)", "Capital restant dû (XOF)",
    "État", "Tranche",
  ]);
  styleHeaderRow(headerRow, nb);
  ws.views = [{ state: "frozen", ySplit: headerRow.number }];

  /* Données */
  dossiers.forEach((d, i) => {
    const dr = ws.addRow({
      n:         i + 1,
      dossier:   d.NUM_DOSSIER,
      nom:       [d.nom, d.prenom].filter(Boolean).join(" ") || "—",
      premEch:   d.premiereEcheanceImpayee ? d.premiereEcheanceImpayee.slice(0, 10) : "—",
      dernEch:   d.derniereEcheanceImpayee ? d.derniereEcheanceImpayee.slice(0, 10) : "—",
      jours:     d.joursRetard,
      nbEch:     d.nbEcheancesImpayees,
      capital:   d.capitalImpaye,
      interet:   d.interetImpaye,
      total:     d.totalImpaye,
      pretInit:  d.montantPretInitial,
      restantDu: d.capitalRestantDu,
      etat:      d.etatPret,
      tranche:   tranche(d.joursRetard),
    });
    styleDataRow(dr, nb, i % 2 === 1);

    /* Coloration jours de retard */
    const jColor = d.joursRetard > 180 ? "7C3AED"
      : d.joursRetard > 90 ? "C2413B"
      : d.joursRetard > 30 ? "D78B1F"
      : "7A1F2B";
    dr.getCell(6).font = { bold: true, color: { argb: "FF" + jColor }, size: 10, name: "Calibri" };
  });

  /* Total */
  const totRow = ws.addRow({
    n: "", dossier: "", nom: "TOTAL", premEch: "", dernEch: "",
    jours:     null,
    nbEch:     dossiers.reduce((s, d) => s + d.nbEcheancesImpayees, 0),
    capital:   dossiers.reduce((s, d) => s + d.capitalImpaye,       0),
    interet:   dossiers.reduce((s, d) => s + d.interetImpaye,       0),
    total:     dossiers.reduce((s, d) => s + d.totalImpaye,         0),
    pretInit:  dossiers.reduce((s, d) => s + d.montantPretInitial,  0),
    restantDu: dossiers.reduce((s, d) => s + d.capitalRestantDu,    0),
    etat: "", tranche: "",
  });
  styleTotalRow(totRow, nb);

  await triggerDownload(wb, `impayes_${agenceCode}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 4 — Encours Crédit par Agence (2 feuilles)
═══════════════════════════════════════════════════════════════ */

export type EncoursCreditBreakdownRow = {
  code: string;
  name: string;
  valeur: number;
  dossiers: number;
  averageAmount: number;
  riskOutstanding: number;
  parRate: number;
};

export type EncoursCreditAgencyExport = {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  total: number;
  dossiers: number;
  averageAmount: number;
  parRate: number;
  riskOutstanding: number;
  productRows: EncoursCreditBreakdownRow[];
  managerRows: EncoursCreditBreakdownRow[];
  appName: string;
};

async function addBreakdownSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  rows: EncoursCreditBreakdownRow[],
  total: number,
  subtitle: string,
): Promise<void> {
  const ws = wb.addWorksheet(sheetName);

  ws.columns = [
    { key: "rang",    width: 6 },
    { key: "code",    width: 12 },
    { key: "libelle", width: 36 },
    { key: "encours", width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "risque",  width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "par",     width: 14, style: { numFmt: FMT_PCT,   alignment: { horizontal: "right" } } },
    { key: "dos",     width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "right" } } },
    { key: "moy",     width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "part",    width: 14, style: { numFmt: FMT_PCT,   alignment: { horizontal: "right" } } },
  ];

  ws.addRow([subtitle]); styleTitleRow(ws.lastRow!, 11);
  ws.addRow([]); ws.addRow([]);

  const hdr = ws.addRow(["Rang", "Code", "Libellé", "Encours (XOF)", "Encours à risque (XOF)", "PAR 1J (%)", "Dossiers", "Encours moyen (XOF)", "Part (%)"]);
  styleHeaderRow(hdr, 9);
  ws.views = [{ state: "frozen", ySplit: 4 }];

  rows.forEach((r, i) => {
    const share = total > 0 ? (r.valeur / total) * 100 : 0;
    const dr = ws.addRow({ rang: i+1, code: r.code, libelle: r.name, encours: r.valeur, risque: r.riskOutstanding, par: r.parRate, dos: r.dossiers, moy: r.averageAmount, part: share });
    styleDataRow(dr, 9, i % 2 === 1);
    if (r.parRate >= 10)     dr.getCell(6).font = { bold: true, color: { argb: "FFC2413B" }, size: 10 };
    else if (r.parRate >= 3) dr.getCell(6).font = { bold: true, color: { argb: "FFD78B1F" }, size: 10 };
  });

  const tot = ws.addRow({ rang: "", code: "", libelle: "TOTAL", encours: total, risque: rows.reduce((s, r) => s + r.riskOutstanding, 0), par: null, dos: rows.reduce((s, r) => s + r.dossiers, 0), moy: null, part: 100 });
  styleTotalRow(tot, 9);
}

export async function exportEncoursCreditAgencyToExcel(p: EncoursCreditAgencyExport): Promise<void> {
  const wb = createWorkbook(p.appName);

  /* Feuille récap */
  const wsR = wb.addWorksheet("Synthèse");
  addTitleBlock(wsR, `Encours Crédit — Agence ${p.agencyCode} : ${p.agencyName}`, `Date d'arrêt : ${p.asOfDate}   —   Généré le ${nowFR()}`, p.appName);
  const rh = wsR.addRow(["Indicateur", "Valeur"]);
  styleHeaderRow(rh, 2);
  wsR.columns = [{ key: "ind", width: 30 }, { key: "val", width: 24 }];
  const kpiLines = [
    ["Encours Crédit total (XOF)",  p.total,            FMT_MONEY],
    ["Nombre de dossiers",          p.dossiers,         FMT_INT],
    ["Encours moyen par dossier",   p.averageAmount,    FMT_MONEY],
    ["Encours à risque (XOF)",      p.riskOutstanding,  FMT_MONEY],
    ["PAR 1 Jour (%)",              p.parRate,          FMT_PCT],
  ];
  kpiLines.forEach(([label, val, fmt], i) => {
    const r = wsR.addRow([label, val]);
    styleDataRow(r, 2, i % 2 === 1);
    r.getCell(2).numFmt = fmt as string;
    r.getCell(2).alignment = { horizontal: "right" };
  });
  wsR.views = [{ state: "frozen", ySplit: 5 }];

  await addBreakdownSheet(wb, "Par Produit",     p.productRows, p.total, `Agence ${p.agencyCode} — Répartition par Produit de crédit`);
  await addBreakdownSheet(wb, "Par Gestionnaire",p.managerRows, p.total, `Agence ${p.agencyCode} — Répartition par Gestionnaire`);

  await triggerDownload(wb, `encours-credit_${p.agencyCode}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 5 — Collecte Tontine par Collecteur
═══════════════════════════════════════════════════════════════ */

export type TontineCollectorRow = {
  collectorCode: string;
  nom: string;
  prenom: string;
  operations: number;
  depotCount: number;
  commissionCount: number;
  annulationCount: number;
  depotAmount: number;
  commissionAmount: number;
  annulationAmount: number;
  valeur: number;
};

export async function exportTontineCollecteAgencyToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart: string;
  total: number;
  operations: number;
  rows: TontineCollectorRow[];
  appName: string;
}): Promise<void> {
  const { rows, agencyCode, agencyName, asOfDate, appName } = params;
  const nb = 9;
  const wb = createWorkbook(appName);
  const ws = wb.addWorksheet("Collecte par Collecteur");

  ws.columns = [
    { key: "rang",       width: 6 },
    { key: "code",       width: 12 },
    { key: "nom",        width: 30 },
    { key: "depotAmt",   width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "comAmt",     width: 18, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "annulAmt",   width: 18, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "valeur",     width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "ops",        width: 12, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
    { key: "part",       width: 14, style: { numFmt: FMT_PCT,   alignment: { horizontal: "right" } } },
  ];

  addTitleBlock(ws, `Collecte Tontine par Collecteur — Agence ${agencyCode} : ${agencyName}`, `Date d'arrêt : ${asOfDate}   —   Généré le ${nowFR()}`, appName);

  const hdr = ws.addRow(["Rang", "Code", "Collecteur", "Dépôts (XOF)", "Commissions (XOF)", "Annulations (XOF)", "Net collecte (XOF)", "Opérations", "Part (%)"]);
  styleHeaderRow(hdr, nb);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  rows.forEach((r, i) => {
    const share = params.total > 0 ? (r.valeur / params.total) * 100 : 0;
    const dr = ws.addRow({ rang: i+1, code: r.collectorCode, nom: [r.nom, r.prenom].filter(Boolean).join(" "), depotAmt: r.depotAmount, comAmt: r.commissionAmount, annulAmt: r.annulationAmount, valeur: r.valeur, ops: r.operations, part: share });
    styleDataRow(dr, nb, i % 2 === 1);
  });

  const tot = ws.addRow({ rang: "", code: "", nom: "TOTAL", depotAmt: rows.reduce((s, r) => s + r.depotAmount, 0), comAmt: rows.reduce((s, r) => s + r.commissionAmount, 0), annulAmt: rows.reduce((s, r) => s + r.annulationAmount, 0), valeur: params.total, ops: params.operations, part: 100 });
  styleTotalRow(tot, nb);

  await triggerDownload(wb, `tontine-collecte_${agencyCode}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 6 — Décaissements par Agence (2 feuilles)
═══════════════════════════════════════════════════════════════ */

export type DecaissementsBreakdownRow = {
  code: string;
  name: string;
  valeur: number;
  operations: number;
  dossiers: number;
  averageAmount: number;
};

export async function exportDecaissementsAgencyToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart?: string;
  total: number;
  operations: number;
  dossiers: number;
  productRows: DecaissementsBreakdownRow[];
  managerRows: DecaissementsBreakdownRow[];
  appName: string;
}): Promise<void> {
  const { agencyCode, agencyName, asOfDate, appName } = params;
  const wb = createWorkbook(appName);

  async function addDecSheet(ws: ExcelJS.Worksheet, rows: DecaissementsBreakdownRow[], label: string) {
    const nb = 7;
    ws.columns = [
      { key: "rang",  width: 6 },
      { key: "code",  width: 12 },
      { key: "lib",   width: 36 },
      { key: "mont",  width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
      { key: "ops",   width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
      { key: "dos",   width: 12, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
      { key: "moy",   width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
      { key: "part",  width: 14, style: { numFmt: FMT_PCT,   alignment: { horizontal: "right" } } },
    ];
    addTitleBlock(ws, `Décaissements — Agence ${agencyCode} : ${agencyName} — ${label}`, `Date d'arrêt : ${asOfDate}   —   Généré le ${nowFR()}`, appName);
    const hdr = ws.addRow(["Rang", "Code", "Libellé", "Montant (XOF)", "Opérations", "Dossiers", "Moyenne (XOF)", "Part (%)"]);
    styleHeaderRow(hdr, nb);
    ws.views = [{ state: "frozen", ySplit: 5 }];
    rows.forEach((r, i) => {
      const share = params.total > 0 ? (r.valeur / params.total) * 100 : 0;
      const dr = ws.addRow({ rang: i+1, code: r.code, lib: r.name, mont: r.valeur, ops: r.operations, dos: r.dossiers, moy: r.averageAmount, part: share });
      styleDataRow(dr, nb, i % 2 === 1);
    });
    const tot = ws.addRow({ rang: "", code: "", lib: "TOTAL", mont: params.total, ops: params.operations, dos: params.dossiers, moy: null, part: 100 });
    styleTotalRow(tot, nb);
  }

  await addDecSheet(wb.addWorksheet("Par Produit"),      params.productRows, "Par Produit de crédit");
  await addDecSheet(wb.addWorksheet("Par Gestionnaire"), params.managerRows, "Par Gestionnaire");

  await triggerDownload(wb, `decaissements_${agencyCode}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 7 — Souscriptions Tontine par Collecteur
═══════════════════════════════════════════════════════════════ */

export type SouscriptionsCollectorRow = {
  collectorCode: string;
  nom: string;
  prenom: string;
  subscriptions: number;
};

export async function exportSouscriptionsTontineAgencyToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  monthStart?: string;
  total: number;
  collectors: number;
  rows: SouscriptionsCollectorRow[];
  appName: string;
}): Promise<void> {
  const { rows, agencyCode, agencyName, asOfDate, appName } = params;
  const nb = 5;
  const wb = createWorkbook(appName);
  const ws = wb.addWorksheet("Souscriptions par Collecteur");

  ws.columns = [
    { key: "rang",  width: 6 },
    { key: "code",  width: 12 },
    { key: "nom",   width: 30 },
    { key: "souscr",width: 16, style: { numFmt: FMT_INT, alignment: { horizontal: "center" } } },
    { key: "part",  width: 14, style: { numFmt: FMT_PCT, alignment: { horizontal: "right" } } },
  ];

  addTitleBlock(ws, `Souscriptions Tontine par Collecteur — Agence ${agencyCode} : ${agencyName}`, `Date d'arrêt : ${asOfDate}   —   Généré le ${nowFR()}`, appName);

  const hdr = ws.addRow(["Rang", "Code", "Collecteur", "Souscriptions", "Part (%)"]);
  styleHeaderRow(hdr, nb);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  rows.forEach((r, i) => {
    const share = params.total > 0 ? (r.subscriptions / params.total) * 100 : 0;
    const dr = ws.addRow({ rang: i+1, code: r.collectorCode, nom: [r.nom, r.prenom].filter(Boolean).join(" "), souscr: r.subscriptions, part: share });
    styleDataRow(dr, nb, i % 2 === 1);
  });

  const tot = ws.addRow({ rang: "", code: "", nom: "TOTAL", souscr: params.total, part: 100 });
  styleTotalRow(tot, nb);

  await triggerDownload(wb, `souscriptions-tontine_${agencyCode}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 8 — Encours Épargne par Agence
═══════════════════════════════════════════════════════════════ */

export type EncoursEpargneProductRow = {
  productKey: string;
  familyCode: string;
  familyName: string;
  productCode: string;
  productName: string;
  valeur: number;
  accounts: number;
  averageBalance: number;
};

export async function exportEncoursEpargneAgencyToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  total: number;
  accounts: number;
  averageBalance: number;
  productRows: EncoursEpargneProductRow[];
  appName: string;
}): Promise<void> {
  const { agencyCode, agencyName, asOfDate, appName, productRows } = params;
  const nb = 8;
  const wb = createWorkbook(appName);

  /* Feuille synthèse */
  const wsS = wb.addWorksheet("Synthèse");
  wsS.columns = [{ key: "ind", width: 32 }, { key: "val", width: 26 }];
  addTitleBlock(wsS, `Encours Épargne — Agence ${agencyCode} : ${agencyName}`, `Date d'arrêt : ${asOfDate}   —   Généré le ${nowFR()}`, appName);
  const sh = wsS.addRow(["Indicateur", "Valeur"]);
  styleHeaderRow(sh, 2);
  [
    ["Encours Épargne total (XOF)",    params.total,          FMT_MONEY],
    ["Nombre de comptes",              params.accounts,       FMT_INT],
    ["Solde moyen par compte (XOF)",   params.averageBalance, FMT_MONEY],
  ].forEach(([l, v, f], i) => {
    const r = wsS.addRow([l, v]);
    styleDataRow(r, 2, i % 2 === 1);
    r.getCell(2).numFmt = f as string;
    r.getCell(2).alignment = { horizontal: "right" };
  });
  wsS.views = [{ state: "frozen", ySplit: 5 }];

  /* Feuille produits */
  const ws = wb.addWorksheet("Par Produit");
  ws.columns = [
    { key: "rang",   width: 6 },
    { key: "famCode",width: 12 },
    { key: "fam",    width: 28 },
    { key: "code",   width: 12 },
    { key: "prod",   width: 32 },
    { key: "encours",width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "cptes",  width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
    { key: "moy",    width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "part",   width: 14, style: { numFmt: FMT_PCT,   alignment: { horizontal: "right" } } },
  ];

  addTitleBlock(ws, `Encours Épargne par Produit — Agence ${agencyCode} : ${agencyName}`, `Date d'arrêt : ${asOfDate}   —   Généré le ${nowFR()}`, appName);
  const hdr = ws.addRow(["Rang", "Famille", "Libellé famille", "Code produit", "Libellé produit", "Encours (XOF)", "Comptes", "Moy. compte (XOF)", "Part (%)"]);
  styleHeaderRow(hdr, nb);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  let prevFamily = "";
  let rank = 0;
  productRows.forEach((r, i) => {
    if (r.familyCode !== prevFamily) {
      const sr = ws.addRow([r.familyName]);
      styleSectionRow(sr, nb);
      ws.mergeCells(sr.number, 1, sr.number, nb);
      prevFamily = r.familyCode;
    }
    rank++;
    const share = params.total > 0 ? (r.valeur / params.total) * 100 : 0;
    const dr = ws.addRow({ rang: rank, famCode: r.familyCode, fam: r.familyName, code: r.productCode, prod: r.productName, encours: r.valeur, cptes: r.accounts, moy: r.averageBalance, part: share });
    styleDataRow(dr, nb, i % 2 === 1);
  });

  const tot = ws.addRow({ rang: "", famCode: "", fam: "", code: "", prod: "TOTAL", encours: params.total, cptes: params.accounts, moy: params.averageBalance, part: 100 });
  styleTotalRow(tot, nb);

  await triggerDownload(wb, `encours-epargne_${agencyCode}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 9 — Encours Crédit — Liste des dossiers
═══════════════════════════════════════════════════════════════ */

export type EncoursCreditDossierRow = {
  numDossier: string;
  clientName: string;
  montantDecaisse: number;
  dateDecaissement: string;
  currentOutstanding: number;
  joursRetard: number;
  etatPret: string;
  etatLibelle: string;
};

export async function exportEncoursCreditDossiersToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  groupType: string;
  groupCode: string;
  groupName: string;
  totalEncours: number;
  totalDecaisse: number;
  dossiersCount: number;
  maxJoursRetard: number;
  dossiers: EncoursCreditDossierRow[];
  appName: string;
}): Promise<void> {
  const { agencyCode, agencyName, asOfDate, appName, dossiers } = params;
  const nb = 8;
  const wb = createWorkbook(appName);
  const groupLabel = params.groupType === "produit" ? "Produit" : "Gestionnaire";
  const ws = wb.addWorksheet("Dossiers");

  ws.columns = [
    { key: "n",       width: 6 },
    { key: "dossier", width: 18 },
    { key: "client",  width: 34 },
    { key: "decaisse",width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "dateDec", width: 14 },
    { key: "encours", width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "jours",   width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
    { key: "etat",    width: 22 },
  ];

  addTitleBlock(
    ws,
    `Dossiers Encours Crédit — ${groupLabel} : ${params.groupName} — Agence ${agencyCode} : ${agencyName}`,
    `Date d'arrêt : ${asOfDate}   —   Généré le ${nowFR()}`,
    appName,
  );
  const hdr = ws.addRow(["N°", "N° Dossier", "Client", "Décaissé (XOF)", "Date déc.", "Encours (XOF)", "Jours retard", "État"]);
  styleHeaderRow(hdr, nb);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  dossiers.forEach((d, i) => {
    const dr = ws.addRow({
      n:       i + 1,
      dossier: d.numDossier,
      client:  d.clientName,
      decaisse:d.montantDecaisse,
      dateDec: d.dateDecaissement ? d.dateDecaissement.slice(0, 10) : "",
      encours: d.currentOutstanding,
      jours:   d.joursRetard,
      etat:    d.etatLibelle || d.etatPret,
    });
    styleDataRow(dr, nb, i % 2 === 1);
    if (d.joursRetard > 180) dr.getCell(7).font = { bold: true, color: { argb: "FF7C3AED" }, size: 10 };
    else if (d.joursRetard > 90) dr.getCell(7).font = { bold: true, color: { argb: "FFC2413B" }, size: 10 };
    else if (d.joursRetard > 30) dr.getCell(7).font = { bold: true, color: { argb: "FFD78B1F" }, size: 10 };
    else if (d.joursRetard > 0) dr.getCell(7).font = { bold: true, color: { argb: "FF7A1F2B" }, size: 10 };
  });

  const tot = ws.addRow({ n: "", dossier: "", client: "TOTAL", decaisse: params.totalDecaisse, dateDec: "", encours: params.totalEncours, jours: null, etat: "" });
  styleTotalRow(tot, nb);

  await triggerDownload(wb, `dossiers-encours-credit_${agencyCode}_${params.groupCode}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 10 — Opérations de Caisse par Agence (par caisse)
═══════════════════════════════════════════════════════════════ */

export type CaisseAgencyDeskRow = {
  cashDeskKey: string;
  cashDeskCode: string;
  cashDeskLabel: string;
  cashDeskAccount: string;
  valeur: number;
  cashInAmount: number;
  cashOutAmount: number;
  operations: number;
};

export async function exportOperationsCaisseAgencyToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  total: number;
  cashInAmount: number;
  cashOutAmount: number;
  operations: number;
  rows: CaisseAgencyDeskRow[];
  appName: string;
}): Promise<void> {
  const { agencyCode, agencyName, asOfDate, appName, rows } = params;
  const nb = 7;
  const wb = createWorkbook(appName);
  const ws = wb.addWorksheet("Par Caisse");

  ws.columns = [
    { key: "rang",    width: 6 },
    { key: "code",    width: 12 },
    { key: "caisse",  width: 32 },
    { key: "entrees", width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "sorties", width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "mouv",    width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "ops",     width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
  ];

  addTitleBlock(ws, `Opérations de Caisse par Caisse — Agence ${agencyCode} : ${agencyName}`, `Journée du : ${asOfDate}   —   Généré le ${nowFR()}`, appName);

  /* Ligne récap agence */
  const recapRow = ws.addRow({ rang: "", code: agencyCode, caisse: agencyName, entrees: params.cashInAmount, sorties: params.cashOutAmount, mouv: params.total, ops: params.operations });
  recapRow.height = 24;
  for (let c = 1; c <= nb; c++) {
    const cell = recapRow.getCell(c);
    cell.fill   = solidFill(C.sectionBg);
    cell.font   = { bold: true, size: 10, color: { argb: "FF" + C.titleFg }, name: "Calibri" };
    if (c > 1 && typeof cell.value === "number") cell.alignment = { horizontal: "right" };
  }

  const hdr = ws.addRow(["Rang", "Code", "Caisse", "Entrées (XOF)", "Sorties (XOF)", "Mouvement (XOF)", "Opérations"]);
  styleHeaderRow(hdr, nb);
  ws.views = [{ state: "frozen", ySplit: 6 }];

  rows.forEach((r, i) => {
    const dr = ws.addRow({ rang: i+1, code: r.cashDeskCode || r.cashDeskKey, caisse: r.cashDeskLabel, entrees: r.cashInAmount, sorties: r.cashOutAmount, mouv: r.valeur, ops: r.operations });
    styleDataRow(dr, nb, i % 2 === 1);
  });

  const tot = ws.addRow({ rang: "", code: "", caisse: "TOTAL", entrees: params.cashInAmount, sorties: params.cashOutAmount, mouv: params.total, ops: params.operations });
  styleTotalRow(tot, nb);

  await triggerDownload(wb, `operations-caisse-agence_${agencyCode}_${asOfDate}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 11 — Opérations de Caisse par Caisse (par catégorie)
═══════════════════════════════════════════════════════════════ */

export type CaisseCategoryRow = {
  categoryCode: string;
  categoryLabel: string;
  direction: "IN" | "OUT";
  valeur: number;
  cashInAmount: number;
  cashOutAmount: number;
  operations: number;
};

export async function exportOperationsCaisseDeskToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  cashDeskCode: string;
  cashDeskLabel: string;
  cashDeskAccount: string;
  total: number;
  cashInAmount: number;
  cashOutAmount: number;
  previousBalance: number;
  calculatedBalance: number;
  operations: number;
  rows: CaisseCategoryRow[];
  appName: string;
}): Promise<void> {
  const { agencyCode, agencyName, asOfDate, appName, rows } = params;
  const nb = 6;
  const wb = createWorkbook(appName);
  const ws = wb.addWorksheet("Par Catégorie");

  ws.columns = [
    { key: "rang",    width: 6 },
    { key: "dir",     width: 10 },
    { key: "cat",     width: 34 },
    { key: "entrees", width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "sorties", width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
    { key: "ops",     width: 14, style: { numFmt: FMT_INT,   alignment: { horizontal: "center" } } },
  ];

  addTitleBlock(ws, `Caisse : ${params.cashDeskLabel} (${params.cashDeskCode}) — Agence ${agencyCode} : ${agencyName}`, `Journée du : ${asOfDate}   —   Généré le ${nowFR()}`, appName);

  /* KPI soldes */
  const kpiRows = [
    ["Solde d'ouverture (XOF)",          params.previousBalance,   FMT_MONEY],
    ["Entrées du jour (XOF)",             params.cashInAmount,      FMT_MONEY],
    ["Sorties du jour (XOF)",             params.cashOutAmount,     FMT_MONEY],
    ["Solde calculé fin de journée (XOF)",params.calculatedBalance, FMT_MONEY],
    ["Nombre d'opérations",               params.operations,        FMT_INT],
  ];
  const kpiHead = ws.addRow(["Indicateur", "Valeur"]);
  styleHeaderRow(kpiHead, 2);
  kpiRows.forEach(([l, v, f], i) => {
    const r = ws.addRow([l, v]);
    styleDataRow(r, 2, i % 2 === 1);
    r.getCell(2).numFmt = f as string;
    r.getCell(2).alignment = { horizontal: "right" };
  });
  ws.addRow([]);

  const hdr = ws.addRow(["Rang", "Sens", "Catégorie", "Entrées (XOF)", "Sorties (XOF)", "Opérations"]);
  styleHeaderRow(hdr, nb);
  ws.views = [{ state: "frozen", ySplit: hdr.number + 1 }];

  rows.forEach((r, i) => {
    const dr = ws.addRow({ rang: i+1, dir: r.direction === "IN" ? "↗ Entrée" : "↘ Sortie", cat: r.categoryLabel, entrees: r.cashInAmount, sorties: r.cashOutAmount, ops: r.operations });
    styleDataRow(dr, nb, i % 2 === 1);
    dr.getCell(2).font = {
      bold: true,
      color: { argb: r.direction === "IN" ? "FF1D7A3A" : "FFC2413B" },
      size: 10, name: "Calibri",
    };
  });

  const tot = ws.addRow({ rang: "", dir: "", cat: "TOTAL", entrees: params.cashInAmount, sorties: params.cashOutAmount, ops: params.operations });
  styleTotalRow(tot, nb);

  await triggerDownload(wb, `caisse_${params.cashDeskCode}_${asOfDate}_${todayStamp()}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT 12 — Opérations de Caisse — Liste des opérations
═══════════════════════════════════════════════════════════════ */

export type CaisseOperationRow = {
  operationSource: string;
  operationId: string;
  operationNumber: string;
  receiptNumber: string;
  operationCode: string;
  operationLabel: string;
  operationDate: string;
  accountNumber: string;
  accountLabel: string;
  customerCode: string;
  customerName: string;
  userCode: string;
  collectorCode: string;
  collectorName: string;
  description: string;
  chequeNumber: string;
  currencyCode: string;
  amount: number;
  direction: "IN" | "OUT";
};

export async function exportOperationsCaisseListToExcel(params: {
  agencyCode: string;
  agencyName: string;
  asOfDate: string;
  cashDeskCode: string;
  cashDeskLabel: string;
  cashDeskAccount: string;
  categoryCode: string;
  categoryLabel: string;
  direction: "IN" | "OUT";
  total: number;
  operations: number;
  rows: CaisseOperationRow[];
  appName: string;
}): Promise<void> {
  const { agencyCode, agencyName, asOfDate, appName, rows } = params;
  const nb = 10;
  const wb = createWorkbook(appName);
  const ws = wb.addWorksheet("Opérations");

  ws.columns = [
    { key: "n",         width: 6 },
    { key: "date",      width: 18 },
    { key: "num",       width: 18 },
    { key: "bordereau", width: 16 },
    { key: "compte",    width: 18 },
    { key: "client",    width: 28 },
    { key: "libelle",   width: 30 },
    { key: "cheque",    width: 14 },
    { key: "util",      width: 14 },
    { key: "montant",   width: 22, style: { numFmt: FMT_MONEY, alignment: { horizontal: "right" } } },
  ];

  addTitleBlock(
    ws,
    `${params.categoryLabel} — Caisse ${params.cashDeskLabel} — Agence ${agencyCode} : ${agencyName}`,
    `Journée du : ${asOfDate}   —   Généré le ${nowFR()}`,
    appName,
  );
  const hdr = ws.addRow(["N°", "Date & heure", "N° Transaction", "Bordereau", "N° Compte", "Client", "Libellé", "Chèque", "Utilisateur", "Montant (XOF)"]);
  styleHeaderRow(hdr, nb);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  rows.forEach((r, i) => {
    const dateStr = r.operationDate ? new Date(r.operationDate).toLocaleString("fr-FR") : "";
    const dr = ws.addRow({
      n:         i + 1,
      date:      dateStr,
      num:       r.operationNumber,
      bordereau: r.receiptNumber,
      compte:    r.accountNumber,
      client:    r.customerName || r.accountLabel,
      libelle:   r.description || r.operationLabel,
      cheque:    r.chequeNumber,
      util:      r.userCode || r.collectorCode,
      montant:   r.amount,
    });
    styleDataRow(dr, nb, i % 2 === 1);
    /* Colorier le montant selon le sens */
    dr.getCell(nb).font = {
      bold: false,
      color: { argb: r.direction === "IN" ? "FF1D7A3A" : "FFC2413B" },
      size: 10, name: "Calibri",
    };
  });

  const tot = ws.addRow({ n: "", date: "", num: "", bordereau: "", compte: "", client: "TOTAL", libelle: "", cheque: "", util: "", montant: params.total });
  styleTotalRow(tot, nb);

  await triggerDownload(wb, `operations_${params.cashDeskCode}_${params.categoryCode}_${asOfDate}_${todayStamp()}.xlsx`);
}
