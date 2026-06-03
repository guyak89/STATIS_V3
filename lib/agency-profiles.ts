import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import sql from "mssql";
import { getAgencySettings, normalizeAgencyCode, type AgencySettings } from "@/lib/agency-settings";

type MssqlRequest = ReturnType<InstanceType<typeof sql.ConnectionPool>["request"]>;

export const ADMIN_UNLOCK_COOKIE = "statis_admin_unlock";
export const ACTIVE_PROFILE_COOKIE = "statis_agency_profile";

const SETTINGS_DIR = path.join(process.cwd(), "data");
const SETTINGS_DB_PATH = path.join(SETTINGS_DIR, "app-settings.sqlite");
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const ADMIN_UNLOCK_SECONDS = 60 * 60 * 8;
const PBKDF2_ITERATIONS = 120_000;

type SecurityRow = {
  id: number;
  admin_pin_hash: string | null;
  admin_pin_salt: string | null;
  app_secret: string;
  updated_at: string;
};

type ProfileRow = {
  id: string;
  name: string;
  pin_hash: string;
  pin_salt: string;
  created_at: string;
  updated_at: string;
};

type ProfileMemberRow = {
  profile_id: string;
  agency_code: string;
};

export type AgencyProfile = {
  id: string;
  name: string;
  agencyCodes: string[];
  createdAt: string;
  updatedAt: string;
};

export type ActiveAgencyProfile = Pick<AgencyProfile, "id" | "name" | "agencyCodes">;

export type AgencyScope = {
  settings: AgencySettings;
  activeProfile: ActiveAgencyProfile | null;
  profileActive: boolean;
  agencyCodes: string[];
  includeCentralAgency: boolean;
  centralAgencyCode: string;
};

const g = global as typeof globalThis & {
  _agencyProfileDb?: Database.Database;
};

function getDb(): Database.Database {
  if (g._agencyProfileDb) return g._agencyProfileDb;

  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const db = new Database(SETTINGS_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS settings_security (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  admin_pin_hash TEXT,
  admin_pin_salt TEXT,
  app_secret TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_profile_members (
  profile_id TEXT NOT NULL,
  agency_code TEXT NOT NULL,
  PRIMARY KEY (profile_id, agency_code),
  FOREIGN KEY (profile_id) REFERENCES agency_profiles(id) ON DELETE CASCADE
);
`);

  const security = db
    .prepare("SELECT id FROM settings_security WHERE id = 1")
    .get() as { id: number } | undefined;
  if (!security) {
    db.prepare(`
INSERT INTO settings_security (id, admin_pin_hash, admin_pin_salt, app_secret, updated_at)
VALUES (1, NULL, NULL, @appSecret, @updatedAt);
`).run({
      appSecret: crypto.randomBytes(32).toString("hex"),
      updatedAt: new Date().toISOString(),
    });
  }

  g._agencyProfileDb = db;
  return db;
}

function securityRow(): SecurityRow {
  return getDb()
    .prepare("SELECT * FROM settings_security WHERE id = 1")
    .get() as SecurityRow;
}

function hashPin(pin: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(pin, salt, PBKDF2_ITERATIONS, 32, "sha256")
    .toString("hex");
  return { hash, salt };
}

function verifyPin(pin: string, hash: string, salt: string): boolean {
  const next = hashPin(pin, salt).hash;
  return crypto.timingSafeEqual(Buffer.from(next, "hex"), Buffer.from(hash, "hex"));
}

function requireValidPin(pin: unknown): string {
  const value = String(pin ?? "").trim();
  if (value.length < 4) {
    throw new Error("Le PIN doit contenir au moins 4 caracteres.");
  }
  return value;
}

function normalizeProfileName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (name.length < 2 || name.length > 80) {
    throw new Error("Nom de profil invalide.");
  }
  return name;
}

function normalizeAgencyCodes(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(normalizeAgencyCode).filter(Boolean))).sort();
}

function hmac(value: string): string {
  return crypto.createHmac("sha256", securityRow().app_secret).update(value).digest("hex");
}

function signValue(value: string): string {
  return `${value}.${hmac(value)}`;
}

function verifySignedValue(signed: string | null | undefined): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  const expected = hmac(value);
  if (signature.length !== expected.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  return ok ? value : null;
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function isAdminPinConfigured(): boolean {
  const row = securityRow();
  return Boolean(row.admin_pin_hash && row.admin_pin_salt);
}

export function isAdminUnlocked(req: Request): boolean {
  if (!isAdminPinConfigured()) return true;
  const value = verifySignedValue(parseCookies(req)[ADMIN_UNLOCK_COOKIE]);
  if (!value) return false;
  const [timestampText] = value.split(":");
  const timestamp = Number(timestampText);
  return Number.isFinite(timestamp) && Date.now() - timestamp < ADMIN_UNLOCK_SECONDS * 1000;
}

export class AdminLockError extends Error {
  constructor() {
    super("Parametrage verrouille.");
    this.name = "AdminLockError";
  }
}

export function assertAdminUnlocked(req: Request): void {
  if (isAdminPinConfigured() && !isAdminUnlocked(req)) {
    throw new AdminLockError();
  }
}

export function verifyAdminPin(pin: unknown): void {
  const row = securityRow();
  if (!row.admin_pin_hash || !row.admin_pin_salt) {
    throw new Error("Aucun PIN administrateur n'est encore defini.");
  }
  if (!verifyPin(String(pin ?? ""), row.admin_pin_hash, row.admin_pin_salt)) {
    throw new Error("PIN administrateur incorrect.");
  }
}

export function saveAdminPin(pin: unknown): void {
  const nextPin = requireValidPin(pin);
  const { hash, salt } = hashPin(nextPin);
  getDb().prepare(`
UPDATE settings_security
SET admin_pin_hash = @hash,
    admin_pin_salt = @salt,
    updated_at = @updatedAt
WHERE id = 1;
`).run({ hash, salt, updatedAt: new Date().toISOString() });
}

export function adminUnlockCookieValue(): string {
  return signValue(`${Date.now()}:admin`);
}

function profileFromRow(row: ProfileRow): AgencyProfile {
  const members = getDb()
    .prepare("SELECT agency_code FROM agency_profile_members WHERE profile_id = ? ORDER BY agency_code")
    .all(row.id) as Array<Pick<ProfileMemberRow, "agency_code">>;
  return {
    id: row.id,
    name: row.name,
    agencyCodes: members.map((member) => member.agency_code),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAgencyProfiles(): AgencyProfile[] {
  const rows = getDb()
    .prepare("SELECT * FROM agency_profiles ORDER BY name")
    .all() as ProfileRow[];
  return rows.map(profileFromRow);
}

export function getAgencyProfile(profileId: string): AgencyProfile | null {
  const row = getDb()
    .prepare("SELECT * FROM agency_profiles WHERE id = ?")
    .get(profileId) as ProfileRow | undefined;
  return row ? profileFromRow(row) : null;
}

export function saveAgencyProfile(input: {
  id?: unknown;
  name: unknown;
  pin?: unknown;
  agencyCodes: unknown;
}): AgencyProfile {
  const now = new Date().toISOString();
  const id = String(input.id ?? crypto.randomUUID()).trim();
  const name = normalizeProfileName(input.name);
  const agencyCodes = normalizeAgencyCodes(input.agencyCodes);
  if (agencyCodes.length === 0) {
    throw new Error("Selectionnez au moins une agence pour le profil.");
  }

  const existing = getDb()
    .prepare("SELECT * FROM agency_profiles WHERE id = ?")
    .get(id) as ProfileRow | undefined;

  if (!existing) {
    const pin = requireValidPin(input.pin);
    const { hash, salt } = hashPin(pin);
    getDb().prepare(`
INSERT INTO agency_profiles (id, name, pin_hash, pin_salt, created_at, updated_at)
VALUES (@id, @name, @hash, @salt, @createdAt, @updatedAt);
`).run({ id, name, hash, salt, createdAt: now, updatedAt: now });
  } else {
    const pin = String(input.pin ?? "").trim();
    if (pin) {
      const { hash, salt } = hashPin(pin);
      getDb().prepare(`
UPDATE agency_profiles
SET name = @name,
    pin_hash = @hash,
    pin_salt = @salt,
    updated_at = @updatedAt
WHERE id = @id;
`).run({ id, name, hash, salt, updatedAt: now });
    } else {
      getDb().prepare(`
UPDATE agency_profiles
SET name = @name,
    updated_at = @updatedAt
WHERE id = @id;
`).run({ id, name, updatedAt: now });
    }
  }

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM agency_profile_members WHERE profile_id = ?").run(id);
    const insert = db.prepare(`
INSERT INTO agency_profile_members (profile_id, agency_code)
VALUES (?, ?);
`);
    for (const agencyCode of agencyCodes) insert.run(id, agencyCode);
  });
  tx();

  const profile = getAgencyProfile(id);
  if (!profile) throw new Error("Profil introuvable apres enregistrement.");
  return profile;
}

export function deleteAgencyProfile(profileId: unknown): void {
  const id = String(profileId ?? "").trim();
  if (!id) throw new Error("Profil invalide.");
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM agency_profile_members WHERE profile_id = ?").run(id);
    db.prepare("DELETE FROM agency_profiles WHERE id = ?").run(id);
  });
  tx();
}

export function verifyProfilePin(profileId: unknown, pin: unknown): AgencyProfile {
  const id = String(profileId ?? "").trim();
  const row = getDb()
    .prepare("SELECT * FROM agency_profiles WHERE id = ?")
    .get(id) as ProfileRow | undefined;
  if (!row) throw new Error("Profil inconnu.");
  if (!verifyPin(String(pin ?? ""), row.pin_hash, row.pin_salt)) {
    throw new Error("PIN du profil incorrect.");
  }
  const profile = profileFromRow(row);
  if (profile.agencyCodes.length === 0) {
    throw new Error("Ce profil ne contient aucune agence.");
  }
  return profile;
}

export function activeProfileCookieValue(profileId: string): string {
  return signValue(profileId);
}

export function getActiveProfileFromRequest(req: Request): ActiveAgencyProfile | null {
  const profileId = verifySignedValue(parseCookies(req)[ACTIVE_PROFILE_COOKIE]);
  if (!profileId) return null;
  const profile = getAgencyProfile(profileId);
  if (!profile || profile.agencyCodes.length === 0) return null;
  return {
    id: profile.id,
    name: profile.name,
    agencyCodes: profile.agencyCodes,
  };
}

export function resolveAgencyScope(req: Request): AgencyScope {
  const settings = getAgencySettings();
  const activeProfile = getActiveProfileFromRequest(req);
  return {
    settings,
    activeProfile,
    profileActive: Boolean(activeProfile),
    agencyCodes: activeProfile?.agencyCodes ?? [],
    includeCentralAgency: activeProfile ? false : settings.includeCentralAgency,
    centralAgencyCode: settings.centralAgencyCode,
  };
}

export function isAgencyAllowedByScope(agencyCode: string, scope: AgencyScope): boolean {
  const code = normalizeAgencyCode(agencyCode);
  if (scope.profileActive) return scope.agencyCodes.includes(code);
  return !(!scope.includeCentralAgency && scope.centralAgencyCode && code === scope.centralAgencyCode);
}

export function filterRowsByAgencyScope<T extends { agencyCode?: unknown }>(
  rows: T[],
  scope: AgencyScope,
): T[] {
  return rows.filter((row) => isAgencyAllowedByScope(String(row.agencyCode ?? ""), scope));
}

export function agencyScopeSql(agencyExpression: string): string {
  return `(
    (
      @AgencyScopeActive = 1
      AND CHARINDEX(
        CONCAT(',', LTRIM(RTRIM(CAST(${agencyExpression} AS varchar(20)))) COLLATE DATABASE_DEFAULT, ','),
        CONCAT(',', @AgencyScopeCodes COLLATE DATABASE_DEFAULT, ',')
      ) > 0
    )
    OR (
      @AgencyScopeActive = 0
      AND (
        @IncludeCentralAgency = 1
        OR @CentralAgencyCode = ''
        OR ${agencyExpression} COLLATE DATABASE_DEFAULT <> @CentralAgencyCode COLLATE DATABASE_DEFAULT
      )
    )
  )`;
}

export function addAgencyScopeInputs(request: MssqlRequest, scope: AgencyScope) {
  return request
    .input("CentralAgencyCode", sql.VarChar(20), scope.centralAgencyCode)
    .input("IncludeCentralAgency", sql.Bit, scope.includeCentralAgency)
    .input("AgencyScopeActive", sql.Bit, scope.profileActive)
    .input("AgencyScopeCodes", sql.VarChar(sql.MAX), scope.agencyCodes.join(","));
}

export function publicAgencyScope(scope: AgencyScope) {
  return {
    centralAgencyCode: scope.centralAgencyCode,
    includeCentralAgency: scope.includeCentralAgency,
    activeProfile: scope.activeProfile,
    consoMutuellesActive: scope.profileActive,
  };
}

export const profileCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: COOKIE_MAX_AGE_SECONDS,
};

export const adminCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: ADMIN_UNLOCK_SECONDS,
};
