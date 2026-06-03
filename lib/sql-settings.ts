import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type SqlSettings = {
  server: string;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectionTimeout: number;
  requestTimeout: number;
  poolMax: number;
  poolMin: number;
  idleTimeoutMillis: number;
  acquireTimeoutMillis: number;
};

export type PublicSqlSettings = Omit<SqlSettings, "password"> & {
  hasPassword: boolean;
  storagePath: string;
  updatedAt: string | null;
};

type SqlSettingsRow = {
  server: string;
  database_name: string;
  user_name: string;
  password: string;
  encrypt: number;
  trust_server_certificate: number;
  connection_timeout_ms: number;
  request_timeout_ms: number;
  pool_max: number;
  pool_min: number;
  pool_idle_timeout_ms: number;
  pool_acquire_timeout_ms: number;
  updated_at: string;
};

const SETTINGS_DIR = path.join(process.cwd(), "data");
const SETTINGS_DB_PATH = path.join(SETTINGS_DIR, "app-settings.sqlite");

const DEFAULTS: SqlSettings = {
  server: process.env.SQL_SERVER ?? "localhost\\SQL2022",
  database: process.env.SQL_DATABASE ?? "BASE_INTERCO",
  user: process.env.SQL_USER ?? "sa",
  password: process.env.SQL_PASSWORD ?? "",
  encrypt: process.env.SQL_ENCRYPT === "true",
  trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE !== "false",
  connectionTimeout: 30_000,
  requestTimeout: 300_000,
  poolMax: 10,
  poolMin: 1,
  idleTimeoutMillis: 60_000,
  acquireTimeoutMillis: 60_000,
};

const g = global as typeof globalThis & {
  _settingsDb?: Database.Database;
};

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function intToBool(value: number): boolean {
  return value === 1;
}

function numberOrDefault(value: unknown, fallback: number, min = 0): number {
  const next = Number(value);
  return Number.isFinite(next) && next >= min ? Math.trunc(next) : fallback;
}

function textOrDefault(value: unknown, fallback: string): string {
  const next = String(value ?? "").trim();
  return next.length > 0 ? next : fallback;
}

function getDb(): Database.Database {
  if (g._settingsDb) return g._settingsDb;

  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const db = new Database(SETTINGS_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS sql_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server TEXT NOT NULL,
  database_name TEXT NOT NULL,
  user_name TEXT NOT NULL,
  password TEXT NOT NULL,
  encrypt INTEGER NOT NULL,
  trust_server_certificate INTEGER NOT NULL,
  connection_timeout_ms INTEGER NOT NULL,
  request_timeout_ms INTEGER NOT NULL,
  pool_max INTEGER NOT NULL,
  pool_min INTEGER NOT NULL,
  pool_idle_timeout_ms INTEGER NOT NULL,
  pool_acquire_timeout_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`);

  g._settingsDb = db;
  return db;
}

function rowToSettings(row: SqlSettingsRow): SqlSettings {
  return {
    server: row.server,
    database: row.database_name,
    user: row.user_name,
    password: row.password,
    encrypt: intToBool(row.encrypt),
    trustServerCertificate: intToBool(row.trust_server_certificate),
    connectionTimeout: row.connection_timeout_ms,
    requestTimeout: row.request_timeout_ms,
    poolMax: row.pool_max,
    poolMin: row.pool_min,
    idleTimeoutMillis: row.pool_idle_timeout_ms,
    acquireTimeoutMillis: row.pool_acquire_timeout_ms,
  };
}

function insertSettings(settings: SqlSettings): string {
  const updatedAt = new Date().toISOString();
  getDb().prepare(`
INSERT INTO sql_settings (
  id, server, database_name, user_name, password, encrypt,
  trust_server_certificate, connection_timeout_ms, request_timeout_ms,
  pool_max, pool_min, pool_idle_timeout_ms, pool_acquire_timeout_ms, updated_at
) VALUES (
  1, @server, @databaseName, @userName, @password, @encrypt,
  @trustServerCertificate, @connectionTimeout, @requestTimeout,
  @poolMax, @poolMin, @idleTimeoutMillis, @acquireTimeoutMillis, @updatedAt
)
ON CONFLICT(id) DO UPDATE SET
  server = excluded.server,
  database_name = excluded.database_name,
  user_name = excluded.user_name,
  password = excluded.password,
  encrypt = excluded.encrypt,
  trust_server_certificate = excluded.trust_server_certificate,
  connection_timeout_ms = excluded.connection_timeout_ms,
  request_timeout_ms = excluded.request_timeout_ms,
  pool_max = excluded.pool_max,
  pool_min = excluded.pool_min,
  pool_idle_timeout_ms = excluded.pool_idle_timeout_ms,
  pool_acquire_timeout_ms = excluded.pool_acquire_timeout_ms,
  updated_at = excluded.updated_at;
`).run({
    server: settings.server,
    databaseName: settings.database,
    userName: settings.user,
    password: settings.password,
    encrypt: boolToInt(settings.encrypt),
    trustServerCertificate: boolToInt(settings.trustServerCertificate),
    connectionTimeout: settings.connectionTimeout,
    requestTimeout: settings.requestTimeout,
    poolMax: settings.poolMax,
    poolMin: settings.poolMin,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    acquireTimeoutMillis: settings.acquireTimeoutMillis,
    updatedAt,
  });
  return updatedAt;
}

function readRow(): SqlSettingsRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sql_settings WHERE id = 1")
    .get() as SqlSettingsRow | undefined;
}

export function getSqlSettingsStoragePath(): string {
  return SETTINGS_DB_PATH;
}

export function getSqlSettings(): SqlSettings {
  const row = readRow();
  if (row) return rowToSettings(row);

  insertSettings(DEFAULTS);
  return DEFAULTS;
}

export function getPublicSqlSettings(): PublicSqlSettings {
  const row = readRow();
  const settings = row ? rowToSettings(row) : getSqlSettings();
  return {
    server: settings.server,
    database: settings.database,
    user: settings.user,
    encrypt: settings.encrypt,
    trustServerCertificate: settings.trustServerCertificate,
    connectionTimeout: settings.connectionTimeout,
    requestTimeout: settings.requestTimeout,
    poolMax: settings.poolMax,
    poolMin: settings.poolMin,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    acquireTimeoutMillis: settings.acquireTimeoutMillis,
    hasPassword: settings.password.length > 0,
    storagePath: SETTINGS_DB_PATH,
    updatedAt: row?.updated_at ?? null,
  };
}

export function resolveSqlSettingsInput(
  input: Partial<SqlSettings>,
  current: SqlSettings = getSqlSettings(),
): SqlSettings {
  const next: SqlSettings = {
    server: textOrDefault(input.server, current.server),
    database: textOrDefault(input.database, current.database),
    user: textOrDefault(input.user, current.user),
    password: typeof input.password === "string" && input.password.length > 0
      ? input.password
      : current.password,
    encrypt: Boolean(input.encrypt),
    trustServerCertificate: Boolean(input.trustServerCertificate),
    connectionTimeout: numberOrDefault(input.connectionTimeout, current.connectionTimeout, 1_000),
    requestTimeout: numberOrDefault(input.requestTimeout, current.requestTimeout, 1_000),
    poolMax: numberOrDefault(input.poolMax, current.poolMax, 1),
    poolMin: numberOrDefault(input.poolMin, current.poolMin, 0),
    idleTimeoutMillis: numberOrDefault(input.idleTimeoutMillis, current.idleTimeoutMillis, 1_000),
    acquireTimeoutMillis: numberOrDefault(input.acquireTimeoutMillis, current.acquireTimeoutMillis, 1_000),
  };

  if (next.poolMin > next.poolMax) {
    next.poolMin = next.poolMax;
  }

  return next;
}

export function saveSqlSettings(input: Partial<SqlSettings>): PublicSqlSettings {
  const next = resolveSqlSettingsInput(input);
  insertSettings(next);
  return getPublicSqlSettings();
}

function parseSqlServerEndpoint(serverInput: string): {
  server: string;
  port?: number;
  instanceName?: string;
} {
  let server = serverInput.trim();
  let port: number | undefined;
  let instanceName: string | undefined;

  const commaPort = server.match(/^(.+),(\d+)$/);
  if (commaPort) {
    server = commaPort[1].trim();
    port = Number(commaPort[2]);
  } else {
    const colonPort = server.match(/^([^:]+):(\d+)$/);
    if (colonPort) {
      server = colonPort[1].trim();
      port = Number(colonPort[2]);
    }
  }

  if (!port && server.includes("\\")) {
    const [host, instance] = server.split("\\", 2);
    server = host.trim();
    instanceName = instance.trim();
  }

  const validPort = typeof port === "number" && Number.isInteger(port) && port > 0;

  return {
    server,
    ...(validPort ? { port } : {}),
    ...(instanceName ? { instanceName } : {}),
  };
}

export function buildMssqlConfig(settings: SqlSettings) {
  if (!settings.password) {
    throw new Error("Le mot de passe SQL Server n'est pas configure.");
  }

  const endpoint = parseSqlServerEndpoint(settings.server);

  return {
    server: endpoint.server,
    ...(endpoint.port ? { port: endpoint.port } : {}),
    database: settings.database,
    user: settings.user,
    password: settings.password,
    options: {
      trustServerCertificate: settings.trustServerCertificate,
      encrypt: settings.encrypt,
      ...(endpoint.instanceName ? { instanceName: endpoint.instanceName } : {}),
    },
    pool: {
      max: settings.poolMax,
      min: settings.poolMin,
      idleTimeoutMillis: settings.idleTimeoutMillis,
      acquireTimeoutMillis: settings.acquireTimeoutMillis,
    },
    connectionTimeout: settings.connectionTimeout,
    requestTimeout: settings.requestTimeout,
  };
}

export function sqlSettingsSignature(settings: SqlSettings): string {
  return JSON.stringify(settings);
}
