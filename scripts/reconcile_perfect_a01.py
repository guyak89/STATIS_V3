from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


ROOT = Path(r"C:\Users\hp\Documents\SQLDATA")
EXPORTS_DIR = ROOT / "exports"
PERFECT_REPORT = Path(r"C:\Users\hp\Documents\ECART.xls")
SQLCMD = Path(r"C:\Program Files\Microsoft SQL Server\100\Tools\Binn\SQLCMD.EXE")
DOSSIER_PATTERN = re.compile(r"^A01PRT\d+$")

AS_OF_DATE = "2026-03-31"
OUTPUT_XLSX = EXPORTS_DIR / f"encours_credit_A01_{AS_OF_DATE}_perfect_aligne.xlsx"
OUTPUT_JSON = EXPORTS_DIR / f"reconciliation_A01_{AS_OF_DATE}.json"

HEADER_FILL = PatternFill("solid", fgColor="1F4E78")
HEADER_FONT = Font(color="FFFFFF", bold=True)
MONEY_FORMAT = "#,##0.00"


def run_sql(query: str) -> list[list[str]]:
    cmd = [
        str(SQLCMD),
        "-S",
        r"localhost\SQL2022",
        "-d",
        "BASE_INTERCO",
        "-E",
        "-Q",
        query,
        "-s",
        "\t",
        "-h",
        "-1",
        "-w",
        "65535",
        "-y",
        "0",
        "-Y",
        "0",
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )
    lines = [line.rstrip("\r\n") for line in result.stdout.splitlines() if line.strip()]
    return [[cell.strip() for cell in line.split("\t")] for line in lines]


def extract_perfect_rows() -> list[dict[str, str]]:
    ps = rf"""
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$wb = $excel.Workbooks.Open('{PERFECT_REPORT}', $null, $true)
$ws = $wb.Worksheets.Item('A')
$range = $ws.UsedRange
$rows = $range.Rows.Count
$data = @()
for ($r=2; $r -le $rows; $r++) {{
  $d = [string]$ws.Cells.Item($r,1).Text
  $encours = [string]$ws.Cells.Item($r,8).Text
  if ($d -and $d.Trim().Length -gt 0) {{
    $data += [pscustomobject]@{{ dossier=$d.Trim(); encours=$encours.Trim() }}
  }}
}}
$wb.Close($false)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($ws) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
$data | ConvertTo-Json -Compress
"""
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )
    payload = result.stdout.strip()
    rows = json.loads(payload) if payload else []
    if isinstance(rows, dict):
        rows = [rows]
    return [row for row in rows if DOSSIER_PATTERN.match(str(row["dossier"]).strip())]


def fetch_a01_extract() -> tuple[list[str], list[list[str]]]:
    query = f"""
SET NOCOUNT ON;
DECLARE @AsOfDate date = '{AS_OF_DATE}';
WITH Remboursements AS (
    SELECT
        rb.NUM_DOSSIER,
        SUM(CAST(ISNULL(rb.CAPITAL_REMB,0) AS MONEY)) AS capital_rembourse,
        MAX(rb.DATE_REMB) AS derniere_date_remb
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
Decaissement AS (
    SELECT
        dc.NUM_DOSSIER,
        MIN(dc.DATE_DECAIS) AS date_decais
    FROM DECAIS dc
    WHERE dc.DATE_DECAIS <= @AsOfDate
    GROUP BY dc.NUM_DOSSIER
),
DeclassementRanked AS (
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
)
SELECT
    p.NUM_DOSSIER,
    LEFT(p.NUM_DOSSIER,3) AS COD_AGENCE,
    d.COD_ADH,
    a.NOM_PRENOM,
    p.ETAT_PRET,
    CONVERT(varchar(10), p.DATE_EFFET, 23) AS DATE_EFFET,
    CONVERT(varchar(10), dec.date_decais, 23) AS DATE_DECAIS,
    CONVERT(varchar(10), p.DATE_SOLDE, 23) AS DATE_SOLDE,
    CAST(p.MONTANT_PRET AS decimal(18,2)) AS MONTANT_PRET,
    CAST(ISNULL(r.capital_rembourse,0) AS decimal(18,2)) AS CAPITAL_REMBOURSE,
    CAST(CASE
        WHEN p.MONTANT_PRET - ISNULL(r.capital_rembourse,0) < 0 THEN 0
        ELSE p.MONTANT_PRET - ISNULL(r.capital_rembourse,0)
    END AS decimal(18,2)) AS ENCOURS_CREDIT,
    CONVERT(varchar(10), r.derniere_date_remb, 23) AS DERNIERE_DATE_REMB
FROM PRETS p
JOIN Decaissement dec
    ON dec.NUM_DOSSIER = p.NUM_DOSSIER
LEFT JOIN Remboursements r
    ON r.NUM_DOSSIER = p.NUM_DOSSIER
LEFT JOIN DEMPRET d
    ON d.REF_DEMANDE = p.REF_DEMANDE
LEFT JOIN ADHERENT a
    ON a.COD_ADH = d.COD_ADH
WHERE (
        (p.ETAT_PRET IN ('SO','DC') AND (p.DATE_SOLDE IS NULL OR p.DATE_SOLDE > @AsOfDate))
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
  AND LEFT(p.NUM_DOSSIER,3) = 'A01'
  AND p.NUM_DOSSIER LIKE '%PRT%'
  AND NOT EXISTS (
      SELECT 1
      FROM LossLoans ll
      WHERE ll.NUM_DOSSIER = p.NUM_DOSSIER
  )
ORDER BY p.NUM_DOSSIER;
"""
    headers = [
        "NUM_DOSSIER",
        "COD_AGENCE",
        "COD_ADH",
        "NOM_PRENOM",
        "ETAT_PRET",
        "DATE_EFFET",
        "DATE_DECAIS",
        "DATE_SOLDE",
        "MONTANT_PRET",
        "CAPITAL_REMBOURSE",
        "ENCOURS_CREDIT",
        "DERNIERE_DATE_REMB",
    ]
    rows = [row for row in run_sql(query) if len(row) == len(headers)]
    return headers, rows


def style_header(ws: Any) -> None:
    for cell in ws[1]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center")


def autosize(ws: Any) -> None:
    for col_idx, column_cells in enumerate(ws.columns, start=1):
        max_len = max(len(str(cell.value)) if cell.value is not None else 0 for cell in column_cells)
        ws.column_dimensions[get_column_letter(col_idx)].width = min(max_len + 2, 36)


def build_workbook(headers: list[str], rows: list[list[str]], report: dict[str, Any]) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "A01 Encours 2026-03-31"
    ws.append(headers)
    for row in rows:
        ws.append(row)
    style_header(ws)
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            if cell.column_letter in {"I", "J", "K"}:
                try:
                    cell.value = float(cell.value)
                    cell.number_format = MONEY_FORMAT
                except Exception:
                    pass
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    autosize(ws)

    summary = wb.create_sheet("Resume")
    summary.append(["Agence", "Date arret", "Nombre de dossiers", "Encours total"])
    summary.append(["A01", AS_OF_DATE, len(rows), f"=SUM('{ws.title}'!K2:K{len(rows)+1})"])
    style_header(summary)
    summary["D2"].number_format = MONEY_FORMAT
    summary.freeze_panes = "A2"
    for col, width in {"A": 12, "B": 14, "C": 18, "D": 18}.items():
        summary.column_dimensions[col].width = width

    compare = wb.create_sheet("Rapprochement")
    compare.append(["Mesure", "Valeur"])
    compare_rows = [
        ("Dossiers Perfect", report["perfect_dossiers_count"]),
        ("Dossiers export SQL", report["export_dossiers_count"]),
        ("Dossiers export encours > 0", report["export_positive_dossiers_count"]),
        ("Perfect absents export", report["perfect_not_in_export_count"]),
        ("Export absents Perfect", report["export_not_in_perfect_count"]),
    ]
    for item in compare_rows:
        compare.append(list(item))
    style_header(compare)
    compare.freeze_panes = "A2"
    compare.column_dimensions["A"].width = 28
    compare.column_dimensions["B"].width = 18

    diff = wb.create_sheet("Ecarts")
    diff.append(["Type", "NUM_DOSSIER"])
    for dossier in report["perfect_not_in_export"]:
        diff.append(["Present dans Perfect, absent export", dossier])
    for dossier in report["export_not_in_perfect"]:
        diff.append(["Present dans export, absent Perfect", dossier])
    style_header(diff)
    diff.freeze_panes = "A2"
    diff.column_dimensions["A"].width = 38
    diff.column_dimensions["B"].width = 24

    wb.save(OUTPUT_XLSX)


def main() -> None:
    EXPORTS_DIR.mkdir(exist_ok=True)
    headers, rows = fetch_a01_extract()
    perfect_rows = extract_perfect_rows()

    export_all = {row[0] for row in rows}
    export_positive = {row[0] for row in rows if float(row[10]) > 0}
    perfect = {str(row["dossier"]).strip() for row in perfect_rows}

    report = {
        "as_of_date": AS_OF_DATE,
        "comparison_key": "NUM_DOSSIER",
        "perfect_dossiers_count": len(perfect),
        "export_dossiers_count": len(export_all),
        "export_positive_dossiers_count": len(export_positive),
        "perfect_not_in_export_count": len(perfect - export_positive),
        "perfect_not_in_export": sorted(perfect - export_positive),
        "export_not_in_perfect_count": len(export_positive - perfect),
        "export_not_in_perfect": sorted(export_positive - perfect),
        "notes": [
            "Perfect footer and title rows are excluded using a dossier pattern match.",
            "Export population uses the mixed rule: SO/DC plus SD with DATE_SOLDE strictly after the cutoff.",
            "Decaissement filter kept: DECAIS.DATE_DECAIS <= cutoff date.",
        ],
    }

    OUTPUT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    build_workbook(headers, rows, report)

    print(OUTPUT_XLSX)
    print(OUTPUT_JSON)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
