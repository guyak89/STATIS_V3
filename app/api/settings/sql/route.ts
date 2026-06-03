import { NextResponse } from "next/server";
import sql from "mssql";
import { AdminLockError, assertAdminUnlocked } from "@/lib/agency-profiles";
import { resetSqlPool } from "@/lib/db";
import { sqlCacheClear } from "@/lib/sql-cache";
import {
  buildMssqlConfig,
  getPublicSqlSettings,
  resolveSqlSettingsInput,
  saveSqlSettings,
  type SqlSettings,
} from "@/lib/sql-settings";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function readBody(req: Request): Promise<Partial<SqlSettings>> {
  const body = await req.json().catch(() => ({}));
  return body as Partial<SqlSettings>;
}

export async function GET() {
  return NextResponse.json(getPublicSqlSettings(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PUT(req: Request) {
  try {
    assertAdminUnlocked(req);
    const body = await readBody(req);
    const settings = saveSqlSettings(body);
    await resetSqlPool();
    sqlCacheClear();

    return NextResponse.json(
      { settings, message: "Parametres SQL enregistres." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: error instanceof AdminLockError ? 403 : 400 });
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  let pool: InstanceType<typeof sql.ConnectionPool> | undefined;

  try {
    assertAdminUnlocked(req);
    const body = await readBody(req);
    const settings = resolveSqlSettingsInput(body);
    pool = await new sql.ConnectionPool(buildMssqlConfig(settings)).connect();
    const result = await pool.request().query(`
SELECT
  DB_NAME() AS databaseName,
  @@SERVERNAME AS serverName,
  CONVERT(varchar(19), GETDATE(), 120) AS serverTime;
`);

    return NextResponse.json(
      {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        info: result.recordset[0] ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json(
      { ok: false, error: message, elapsedMs: Date.now() - startedAt },
      { status: error instanceof AdminLockError ? 403 : 400 },
    );
  } finally {
    if (pool) {
      try { await pool.close(); } catch { /* ignore */ }
    }
  }
}
