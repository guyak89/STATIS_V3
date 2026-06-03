import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type AgencySettings = {
  centralAgencyCode: string;
  includeCentralAgency: boolean;
};

export type PublicAgencySettings = AgencySettings & {
  storagePath: string;
  updatedAt: string | null;
};

type AgencySettingsRow = {
  central_agency_code: string;
  include_central_agency: number;
  updated_at: string;
};

const SETTINGS_DIR = path.join(process.cwd(), "data");
const SETTINGS_DB_PATH = path.join(SETTINGS_DIR, "app-settings.sqlite");

const DEFAULTS: AgencySettings = {
  centralAgencyCode: "",
  includeCentralAgency: false,
};

const g = global as typeof globalThis & {
  _agencySettingsDb?: Database.Database;
};

function getDb(): Database.Database {
  if (g._agencySettingsDb) return g._agencySettingsDb;

  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const db = new Database(SETTINGS_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS agency_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  central_agency_code TEXT NOT NULL,
  include_central_agency INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`);

  g._agencySettingsDb = db;
  return db;
}

export function normalizeAgencyCode(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function validateCentralAgencyCode(value: string): string {
  const next = normalizeAgencyCode(value);
  if (next && !/^[A-Z0-9_-]{1,20}$/.test(next)) {
    throw new Error("Code agence faitiere invalide.");
  }
  return next;
}

function rowToSettings(row: AgencySettingsRow): AgencySettings {
  return {
    centralAgencyCode: row.central_agency_code,
    includeCentralAgency: row.include_central_agency === 1,
  };
}

function insertSettings(settings: AgencySettings): string {
  const updatedAt = new Date().toISOString();
  getDb().prepare(`
INSERT INTO agency_settings (id, central_agency_code, include_central_agency, updated_at)
VALUES (1, @centralAgencyCode, @includeCentralAgency, @updatedAt)
ON CONFLICT(id) DO UPDATE SET
  central_agency_code = excluded.central_agency_code,
  include_central_agency = excluded.include_central_agency,
  updated_at = excluded.updated_at;
`).run({
    centralAgencyCode: settings.centralAgencyCode,
    includeCentralAgency: settings.includeCentralAgency ? 1 : 0,
    updatedAt,
  });

  return updatedAt;
}

function readRow(): AgencySettingsRow | undefined {
  return getDb()
    .prepare("SELECT * FROM agency_settings WHERE id = 1")
    .get() as AgencySettingsRow | undefined;
}

export function getAgencySettings(): AgencySettings {
  const row = readRow();
  if (row) return rowToSettings(row);

  insertSettings(DEFAULTS);
  return DEFAULTS;
}

export function getPublicAgencySettings(): PublicAgencySettings {
  const row = readRow();
  const settings = row ? rowToSettings(row) : getAgencySettings();
  return {
    ...settings,
    storagePath: SETTINGS_DB_PATH,
    updatedAt: row?.updated_at ?? null,
  };
}

export function saveAgencySettings(input: Partial<AgencySettings>): PublicAgencySettings {
  const current = getAgencySettings();
  const next: AgencySettings = {
    centralAgencyCode: input.centralAgencyCode === undefined
      ? current.centralAgencyCode
      : validateCentralAgencyCode(input.centralAgencyCode),
    includeCentralAgency: input.includeCentralAgency === undefined
      ? current.includeCentralAgency
      : Boolean(input.includeCentralAgency),
  };

  insertSettings(next);
  return getPublicAgencySettings();
}

export function shouldExcludeCentralAgency(agencyCode: string, settings = getAgencySettings()): boolean {
  return !settings.includeCentralAgency
    && settings.centralAgencyCode.length > 0
    && normalizeAgencyCode(agencyCode) === settings.centralAgencyCode;
}

export function filterAgencyRows<T extends { agencyCode?: unknown }>(
  rows: T[],
  settings = getAgencySettings(),
): T[] {
  if (settings.includeCentralAgency || !settings.centralAgencyCode) return rows;
  return rows.filter((row) => normalizeAgencyCode(row.agencyCode) !== settings.centralAgencyCode);
}

export function isCentralAgencyExcluded(settings = getAgencySettings()): boolean {
  return !settings.includeCentralAgency && settings.centralAgencyCode.length > 0;
}

export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function agencyExclusionSql(
  agencyExpression: string,
  settings = getAgencySettings(),
): string {
  if (!isCentralAgencyExcluded(settings)) return "";
  const code = sqlStringLiteral(settings.centralAgencyCode);
  return `AND ${agencyExpression} COLLATE DATABASE_DEFAULT <> ${code} COLLATE DATABASE_DEFAULT`;
}
