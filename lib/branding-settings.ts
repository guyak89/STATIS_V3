import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type BrandingSettings = {
  appName: string;
  logoUrl: string;
};

export type PublicBrandingSettings = BrandingSettings & {
  storagePath: string;
  updatedAt: string | null;
};

type BrandingSettingsRow = {
  app_name: string;
  logo_url: string;
  updated_at: string;
};

const SETTINGS_DIR = path.join(process.cwd(), "data");
const SETTINGS_DB_PATH = path.join(SETTINGS_DIR, "app-settings.sqlite");

const DEFAULTS: BrandingSettings = {
  appName: "STATIS",
  logoUrl: "/uploads/logo-urclec.png",
};

const g = global as typeof globalThis & {
  _brandingSettingsDb?: Database.Database;
};

function textOrDefault(value: unknown, fallback: string): string {
  const next = String(value ?? "").trim();
  return next.length > 0 ? next : fallback;
}

function getDb(): Database.Database {
  if (g._brandingSettingsDb) return g._brandingSettingsDb;

  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const db = new Database(SETTINGS_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS branding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_name TEXT NOT NULL,
  logo_url TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

  g._brandingSettingsDb = db;
  return db;
}

function rowToSettings(row: BrandingSettingsRow): BrandingSettings {
  return {
    appName: row.app_name,
    logoUrl: row.logo_url,
  };
}

function insertSettings(settings: BrandingSettings): string {
  const updatedAt = new Date().toISOString();
  getDb().prepare(`
INSERT INTO branding_settings (id, app_name, logo_url, updated_at)
VALUES (1, @appName, @logoUrl, @updatedAt)
ON CONFLICT(id) DO UPDATE SET
  app_name = excluded.app_name,
  logo_url = excluded.logo_url,
  updated_at = excluded.updated_at;
`).run({
    appName: settings.appName,
    logoUrl: settings.logoUrl,
    updatedAt,
  });

  return updatedAt;
}

function readRow(): BrandingSettingsRow | undefined {
  return getDb()
    .prepare("SELECT * FROM branding_settings WHERE id = 1")
    .get() as BrandingSettingsRow | undefined;
}

export function getBrandingSettings(): BrandingSettings {
  const row = readRow();
  if (row) return rowToSettings(row);

  insertSettings(DEFAULTS);
  return DEFAULTS;
}

export function getPublicBrandingSettings(): PublicBrandingSettings {
  const row = readRow();
  const settings = row ? rowToSettings(row) : getBrandingSettings();
  return {
    ...settings,
    storagePath: SETTINGS_DB_PATH,
    updatedAt: row?.updated_at ?? null,
  };
}

export function saveBrandingSettings(input: Partial<BrandingSettings>): PublicBrandingSettings {
  const current = getBrandingSettings();
  const next: BrandingSettings = {
    appName: textOrDefault(input.appName, current.appName),
    logoUrl: textOrDefault(input.logoUrl, current.logoUrl),
  };

  insertSettings(next);
  return getPublicBrandingSettings();
}
