import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import sql from "mssql";

const ROOT = process.cwd();
const SETTINGS_DB = path.join(ROOT, "data", "app-settings.sqlite");
const OUTPUT_DIR = path.join(ROOT, "exports");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "PAR_1J_MUTUELLE_AVENIR_2026-05-14.xlsx");

const AS_OF_DATE = "2026-05-14";
const AGENCY_CODE = "A01";
const AGENCY_NAME = "MUTUELLE AVENIR";

function readSqlSettings() {
  const db = new Database(SETTINGS_DB, { readonly: true });
  const row = db.prepare("SELECT * FROM sql_settings WHERE id = 1").get();
  db.close();

  if (!row) {
    throw new Error(`Parametres SQL introuvables dans ${SETTINGS_DB}`);
  }

  return {
    server: row.server,
    database: row.database_name,
    user: row.user_name,
    password: row.password,
    options: {
      encrypt: row.encrypt === 1,
      trustServerCertificate: row.trust_server_certificate === 1,
    },
    connectionTimeout: row.connection_timeout_ms,
    requestTimeout: row.request_timeout_ms,
    pool: {
      max: row.pool_max,
      min: row.pool_min,
      idleTimeoutMillis: row.pool_idle_timeout_ms,
      acquireTimeoutMillis: row.pool_acquire_timeout_ms,
    },
  };
}

const query = `
SET NOCOUNT ON;

DECLARE @AsOfDate date = @AsOfDateInput;
DECLARE @AgencyCode varchar(3) = @AgencyCodeInput;

WITH DeclassementRanked AS (
  SELECT
    dh.NUM_DOSSIER,
    dh.COD_TYP_OPERAT,
    ROW_NUMBER() OVER (
      PARTITION BY dh.NUM_DOSSIER
      ORDER BY dh.DATE_DECLAS_HIST DESC, dh.NUM_TRANS DESC
    ) AS rn
  FROM DECLAS_HIST dh
  WHERE dh.DATE_DECLAS_HIST <= @AsOfDate
    AND (dh.DATE_FIN IS NULL OR dh.DATE_FIN > @AsOfDate)
),
LossLoans AS (
  SELECT dr.NUM_DOSSIER
  FROM DeclassementRanked dr
  WHERE dr.rn = 1
    AND dr.COD_TYP_OPERAT = 'TRPE'
),
FutureLossTransfers AS (
  SELECT DISTINCT dh.NUM_DOSSIER
  FROM DECLAS_HIST dh
  WHERE dh.COD_TYP_OPERAT = 'TRPE'
    AND dh.DATE_DECLAS_HIST > @AsOfDate
),
Remboursements AS (
  SELECT
    rb.NUM_DOSSIER,
    SUM(CAST(ISNULL(rb.CAPITAL_REMB, 0) AS money)) AS capitalRembourse,
    MAX(rb.DATE_REMB) AS derniereDateRemb
  FROM REMBOURS rb
  WHERE rb.DATE_REMB <= @AsOfDate
    AND EXISTS (
      SELECT 1
      FROM TABAMOR tb
      WHERE tb.NUM_DOSSIER = rb.NUM_DOSSIER
        AND tb.DATE_ECHEANCE = rb.DATE_ECHEANCE
    )
  GROUP BY rb.NUM_DOSSIER
),
Decaissements AS (
  SELECT
    dc.NUM_DOSSIER,
    SUM(CAST(ISNULL(dc.MONTANT_DECAIS, 0) AS money)) AS montantDecaisse,
    MIN(dc.DATE_DECAIS) AS premiereDateDecais,
    MAX(dc.DATE_DECAIS) AS derniereDateDecais
  FROM DECAIS dc
  WHERE dc.DATE_DECAIS <= @AsOfDate
  GROUP BY dc.NUM_DOSSIER
),
LoanPortfolio AS (
  SELECT
    p.NUM_DOSSIER,
    LEFT(p.NUM_DOSSIER, 3) AS agencyCode,
    dp.COD_ADH,
    ad.NUM_MANUEL,
    ad.NOM_PRENOM,
    ad.TEL,
    ad.NUM_CEL,
    p.ETAT_PRET,
    CASE
      WHEN p.ETAT_PRET = 'DC' THEN 'Sain'
      WHEN p.ETAT_PRET = 'SO' THEN 'Souffrant'
      WHEN p.ETAT_PRET = 'SD' THEN 'Solde apres situation'
      WHEN p.ETAT_PRET = 'PE' THEN 'Perte apres situation'
      ELSE p.ETAT_PRET
    END AS etatLibelle,
    dp.COD_PRDT_CRD AS codeProduit,
    COALESCE(NULLIF(LTRIM(RTRIM(pc.NOM_PRDT_CRD)), ''), dp.COD_PRDT_CRD, 'Produit non identifie') AS produit,
    dp.COD_GEST AS codeGestionnaire,
    COALESCE(
      NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(g.NOM, ''), ' ', ISNULL(g.PRENOM, '')))), ''),
      dp.COD_GEST,
      'Gestionnaire non identifie'
    ) AS gestionnaire,
    CAST(ISNULL(p.MONTANT_PRET, 0) AS money) AS montantPret,
    CAST(ISNULL(d.montantDecaisse, 0) AS money) AS montantDecaisse,
    d.premiereDateDecais AS dateDecaissement,
    p.DATE_EFFET,
    p.DERNIERE_ECHE,
    p.DATE_SOLDE,
    ISNULL(r.capitalRembourse, 0) AS capitalRembourse,
    r.derniereDateRemb,
    CASE
      WHEN ISNULL(p.MONTANT_PRET, 0) - ISNULL(r.capitalRembourse, 0) < 0 THEN CAST(0 AS money)
      ELSE CAST(ISNULL(p.MONTANT_PRET, 0) - ISNULL(r.capitalRembourse, 0) AS money)
    END AS encoursCredit
  FROM PRETS p
  JOIN DEMPRET dp
    ON dp.REF_DEMANDE = p.REF_DEMANDE
  LEFT JOIN ADHERENT ad
    ON ad.COD_ADH = dp.COD_ADH
  LEFT JOIN PRDT_CRD pc
    ON pc.COD_PRDT_CRD = dp.COD_PRDT_CRD
  LEFT JOIN GESTIONNAIRE g
    ON g.COD_GEST = dp.COD_GEST
  LEFT JOIN Remboursements r
    ON r.NUM_DOSSIER = p.NUM_DOSSIER
  JOIN Decaissements d
    ON d.NUM_DOSSIER = p.NUM_DOSSIER
  WHERE LEFT(p.NUM_DOSSIER, 3) = @AgencyCode
    AND (
      (p.ETAT_PRET IN ('SO', 'DC') AND (p.DATE_SOLDE IS NULL OR p.DATE_SOLDE > @AsOfDate))
      OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
      OR (
        p.ETAT_PRET = 'PE'
        AND EXISTS (
          SELECT 1
          FROM FutureLossTransfers flt
          WHERE flt.NUM_DOSSIER = p.NUM_DOSSIER
        )
      )
    )
    AND p.NUM_DOSSIER LIKE '%PRT%'
    AND NOT EXISTS (
      SELECT 1
      FROM LossLoans ll
      WHERE ll.NUM_DOSSIER = p.NUM_DOSSIER
    )
),
ActiveLoanPortfolio AS (
  SELECT *
  FROM LoanPortfolio
  WHERE encoursCredit > 0
),
DueCapital AS (
  SELECT
    t.NUM_DOSSIER,
    SUM(CAST(ISNULL(t.CAPITAL, 0) AS money)) AS capitalEchu,
    MIN(t.DATE_ECHEANCE) AS premiereEcheanceEchue,
    MAX(t.DATE_ECHEANCE) AS derniereEcheanceEchue
  FROM TABAMOR t
  JOIN ActiveLoanPortfolio lp
    ON lp.NUM_DOSSIER = t.NUM_DOSSIER
  WHERE t.DATE_ECHEANCE < @AsOfDate
  GROUP BY t.NUM_DOSSIER
),
ParLoans AS (
  SELECT
    lp.*,
    ISNULL(dc.capitalEchu, 0) AS capitalEchu,
    CASE
      WHEN ISNULL(dc.capitalEchu, 0) - ISNULL(lp.capitalRembourse, 0) > 0
      THEN ISNULL(dc.capitalEchu, 0) - ISNULL(lp.capitalRembourse, 0)
      ELSE CAST(0 AS money)
    END AS capitalImpaye,
    dc.premiereEcheanceEchue,
    dc.derniereEcheanceEchue,
    DATEDIFF(DAY, dc.premiereEcheanceEchue, @AsOfDate) AS joursRetard
  FROM ActiveLoanPortfolio lp
  LEFT JOIN DueCapital dc
    ON dc.NUM_DOSSIER = lp.NUM_DOSSIER
  WHERE ISNULL(dc.capitalEchu, 0) > ISNULL(lp.capitalRembourse, 0)
)
SELECT
  @AsOfDate AS dateArret,
  @AgencyCode AS codeAgence,
  NUM_DOSSIER,
  COD_ADH,
  NUM_MANUEL,
  NOM_PRENOM,
  TEL,
  NUM_CEL,
  etatLibelle,
  ETAT_PRET,
  codeProduit,
  produit,
  codeGestionnaire,
  gestionnaire,
  montantPret,
  montantDecaisse,
  dateDecaissement,
  DATE_EFFET,
  DERNIERE_ECHE,
  DATE_SOLDE,
  capitalEchu,
  capitalRembourse,
  capitalImpaye,
  encoursCredit AS soldeEncours,
  premiereEcheanceEchue,
  derniereEcheanceEchue,
  joursRetard,
  derniereDateRemb
FROM ParLoans
ORDER BY soldeEncours DESC, NUM_DOSSIER;
`;

function normalizeRows(recordset) {
  return recordset.map((row) => ({
    dateArret: row.dateArret,
    codeAgence: row.codeAgence,
    numDossier: row.NUM_DOSSIER,
    codAdh: row.COD_ADH,
    numManuel: row.NUM_MANUEL,
    nomPrenom: row.NOM_PRENOM,
    tel: row.TEL,
    numCel: row.NUM_CEL,
    etat: row.etatLibelle,
    etatCode: row.ETAT_PRET,
    codeProduit: row.codeProduit,
    produit: row.produit,
    codeGestionnaire: row.codeGestionnaire,
    gestionnaire: row.gestionnaire,
    montantPret: Number(row.montantPret ?? 0),
    montantDecaisse: Number(row.montantDecaisse ?? 0),
    dateDecaissement: row.dateDecaissement,
    dateEffet: row.DATE_EFFET,
    derniereEcheance: row.DERNIERE_ECHE,
    dateSolde: row.DATE_SOLDE,
    capitalEchu: Number(row.capitalEchu ?? 0),
    capitalRembourse: Number(row.capitalRembourse ?? 0),
    capitalImpaye: Number(row.capitalImpaye ?? 0),
    soldeEncours: Number(row.soldeEncours ?? 0),
    premiereEcheanceEchue: row.premiereEcheanceEchue,
    derniereEcheanceEchue: row.derniereEcheanceEchue,
    joursRetard: Number(row.joursRetard ?? 0),
    derniereDateRemb: row.derniereDateRemb,
  }));
}

function excelDate(value) {
  return value instanceof Date ? value : value ? new Date(value) : null;
}

function setHeaderStyle(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7A1F2B" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9C7C7" } },
      left: { style: "thin", color: { argb: "FFD9C7C7" } },
      bottom: { style: "thin", color: { argb: "FFD9C7C7" } },
      right: { style: "thin", color: { argb: "FFD9C7C7" } },
    };
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const pool = await new sql.ConnectionPool(readSqlSettings()).connect();
  try {
    const result = await pool.request()
      .input("AsOfDateInput", sql.Date, AS_OF_DATE)
      .input("AgencyCodeInput", sql.VarChar(3), AGENCY_CODE)
      .query(query);

    const rows = normalizeRows(result.recordset ?? []);
    const totalSolde = rows.reduce((sum, row) => sum + row.soldeEncours, 0);
    const totalImpaye = rows.reduce((sum, row) => sum + row.capitalImpaye, 0);
    const totalMontantPret = rows.reduce((sum, row) => sum + row.montantPret, 0);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "STATIS";
    workbook.created = new Date();
    workbook.modified = new Date();

    const summary = workbook.addWorksheet("Résumé");
    summary.properties.defaultRowHeight = 21;
    summary.columns = [
      { key: "label", width: 34 },
      { key: "value", width: 28 },
    ];
    summary.mergeCells("A1:B1");
    summary.getCell("A1").value = `PAR 1J - ${AGENCY_NAME}`;
    summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF7A1F2B" } };
    summary.getCell("A1").alignment = { horizontal: "center" };

    const summaryRows = [
      ["Date d'arrêt", AS_OF_DATE],
      ["Agence", `${AGENCY_CODE} - ${AGENCY_NAME}`],
      ["Nombre de dossiers PAR 1J", rows.length],
      ["Solde encours total", totalSolde],
      ["Capital impayé total", totalImpaye],
      ["Montant prêt total", totalMontantPret],
      ["Règle PAR 1J", "capital échu avant date d'arrêt > capital remboursé à date"],
    ];
    summary.addRows(summaryRows);
    summary.getColumn(2).numFmt = '#,##0';
    summary.getCell("B2").numFmt = "yyyy-mm-dd";
    summary.eachRow((row, rowNumber) => {
      if (rowNumber >= 2) {
        row.getCell(1).font = { bold: true };
        row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4E9E6" } };
      }
    });

    const detail = workbook.addWorksheet("Dossiers PAR 1J");
    detail.views = [{ state: "frozen", ySplit: 1 }];
    detail.autoFilter = "A1:AB1";
    detail.columns = [
      { header: "Date arrêt", key: "dateArret", width: 13 },
      { header: "Agence", key: "codeAgence", width: 10 },
      { header: "Num dossier", key: "numDossier", width: 20 },
      { header: "Code adhérent", key: "codAdh", width: 14 },
      { header: "Num manuel", key: "numManuel", width: 14 },
      { header: "Nom client", key: "nomPrenom", width: 32 },
      { header: "Téléphone", key: "tel", width: 16 },
      { header: "Cellulaire", key: "numCel", width: 16 },
      { header: "Etat", key: "etat", width: 18 },
      { header: "Code état", key: "etatCode", width: 10 },
      { header: "Code produit", key: "codeProduit", width: 14 },
      { header: "Produit", key: "produit", width: 28 },
      { header: "Code gestionnaire", key: "codeGestionnaire", width: 18 },
      { header: "Gestionnaire", key: "gestionnaire", width: 28 },
      { header: "Montant prêt", key: "montantPret", width: 16 },
      { header: "Montant décaissé", key: "montantDecaisse", width: 18 },
      { header: "Date décaissement", key: "dateDecaissement", width: 18 },
      { header: "Date effet", key: "dateEffet", width: 14 },
      { header: "Dernière échéance", key: "derniereEcheance", width: 18 },
      { header: "Date solde", key: "dateSolde", width: 14 },
      { header: "Capital échu", key: "capitalEchu", width: 16 },
      { header: "Capital remboursé", key: "capitalRembourse", width: 18 },
      { header: "Capital impayé", key: "capitalImpaye", width: 16 },
      { header: "Solde encours", key: "soldeEncours", width: 16 },
      { header: "1ère échéance échue", key: "premiereEcheanceEchue", width: 20 },
      { header: "Dernière échéance échue", key: "derniereEcheanceEchue", width: 22 },
      { header: "Jours retard", key: "joursRetard", width: 13 },
      { header: "Dernier remboursement", key: "derniereDateRemb", width: 20 },
    ];

    detail.getRow(1).height = 34;
    setHeaderStyle(detail.getRow(1));

    rows.forEach((row) => {
      detail.addRow({
        ...row,
        dateArret: excelDate(row.dateArret),
        dateDecaissement: excelDate(row.dateDecaissement),
        dateEffet: excelDate(row.dateEffet),
        derniereEcheance: excelDate(row.derniereEcheance),
        dateSolde: excelDate(row.dateSolde),
        premiereEcheanceEchue: excelDate(row.premiereEcheanceEchue),
        derniereEcheanceEchue: excelDate(row.derniereEcheanceEchue),
        derniereDateRemb: excelDate(row.derniereDateRemb),
      });
    });

    for (const columnKey of ["montantPret", "montantDecaisse", "capitalEchu", "capitalRembourse", "capitalImpaye", "soldeEncours"]) {
      detail.getColumn(columnKey).numFmt = '#,##0';
    }
    for (const columnKey of ["dateArret", "dateDecaissement", "dateEffet", "derniereEcheance", "dateSolde", "premiereEcheanceEchue", "derniereEcheanceEchue", "derniereDateRemb"]) {
      detail.getColumn(columnKey).numFmt = "yyyy-mm-dd";
    }
    detail.eachRow((row, rowNumber) => {
      if (rowNumber > 1 && rowNumber % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFAF7" } };
        });
      }
    });

    await workbook.xlsx.writeFile(OUTPUT_FILE);

    const verification = {
      outputFile: OUTPUT_FILE,
      dossiers: rows.length,
      totalSolde,
      totalImpaye,
      totalMontantPret,
    };
    console.log(JSON.stringify(verification, null, 2));
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
