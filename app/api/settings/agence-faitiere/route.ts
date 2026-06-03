import { NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "@/lib/db";
import {
  getPublicAgencySettings,
  normalizeAgencyCode,
  saveAgencySettings,
  type AgencySettings,
} from "@/lib/agency-settings";
import { AdminLockError, assertAdminUnlocked, getActiveProfileFromRequest } from "@/lib/agency-profiles";
import { sqlCacheClear } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type AgencyOption = {
  agencyCode: string;
  agencyName: string;
};

async function readBody(req: Request): Promise<Partial<AgencySettings>> {
  const body = await req.json().catch(() => ({}));
  return body as Partial<AgencySettings>;
}

async function listAgencies(): Promise<AgencyOption[]> {
  const pool = await getPool();
  const result = await pool.request().query(`
SELECT
  COD_AGENCE AS agencyCode,
  RAISON_SOCIAL AS agencyName
FROM AGENCE
ORDER BY COD_AGENCE;
`);
  return (result.recordset ?? []) as AgencyOption[];
}

async function ensureAgencyExists(agencyCode: string): Promise<void> {
  if (!agencyCode) return;

  const pool = await getPool();
  const result = await pool.request()
    .input("AgencyCode", sql.VarChar(20), agencyCode)
    .query(`
SELECT TOP 1 COD_AGENCE
FROM AGENCE
WHERE COD_AGENCE COLLATE DATABASE_DEFAULT = @AgencyCode COLLATE DATABASE_DEFAULT;
`);

  if ((result.recordset ?? []).length === 0) {
    throw new Error(`Agence inconnue dans Perfect : ${agencyCode}`);
  }
}

export async function GET(req: Request) {
  try {
    const activeProfile = getActiveProfileFromRequest(req);
    const [settings, agencies] = await Promise.all([
      Promise.resolve(getPublicAgencySettings()),
      listAgencies(),
    ]);

    return NextResponse.json(
      {
        settings: {
          ...settings,
          includeCentralAgency: activeProfile ? false : settings.includeCentralAgency,
          activeProfile,
          consoMutuellesActive: Boolean(activeProfile),
        },
        agencies,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    assertAdminUnlocked(req);
    const body = await readBody(req);
    const activeProfile = getActiveProfileFromRequest(req);
    const centralAgencyCode = normalizeAgencyCode(body.centralAgencyCode);
    await ensureAgencyExists(centralAgencyCode);

    const settings = saveAgencySettings({
      centralAgencyCode,
      includeCentralAgency: activeProfile ? false : body.includeCentralAgency,
    });
    sqlCacheClear();

    return NextResponse.json(
      { settings, message: "Parametrage agence faitiere enregistre." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: error instanceof AdminLockError ? 403 : 400 });
  }
}
