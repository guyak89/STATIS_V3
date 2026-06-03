import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  AdminLockError,
  assertAdminUnlocked,
  deleteAgencyProfile,
  getActiveProfileFromRequest,
  listAgencyProfiles,
  saveAgencyProfile,
} from "@/lib/agency-profiles";
import { sqlCacheClear } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type AgencyOption = {
  agencyCode: string;
  agencyName: string;
};

async function readBody(req: Request) {
  return req.json().catch(() => ({})) as Promise<Record<string, unknown>>;
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

export async function GET(req: Request) {
  try {
    const [profiles, agencies] = await Promise.all([
      Promise.resolve(listAgencyProfiles()),
      listAgencies(),
    ]);
    return NextResponse.json(
      {
        profiles,
        agencies,
        activeProfile: getActiveProfileFromRequest(req),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    assertAdminUnlocked(req);
    const body = await readBody(req);
    const profile = saveAgencyProfile({
      name: body.name,
      pin: body.pin,
      agencyCodes: body.agencyCodes,
    });
    sqlCacheClear();
    return NextResponse.json(
      { profile, message: "Profil de conso mutuelles cree." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: error instanceof AdminLockError ? 403 : 400 });
  }
}

export async function PUT(req: Request) {
  try {
    assertAdminUnlocked(req);
    const body = await readBody(req);
    const profile = saveAgencyProfile({
      id: body.id,
      name: body.name,
      pin: body.pin,
      agencyCodes: body.agencyCodes,
    });
    sqlCacheClear();
    return NextResponse.json(
      { profile, message: "Profil de conso mutuelles enregistre." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: error instanceof AdminLockError ? 403 : 400 });
  }
}

export async function DELETE(req: Request) {
  try {
    assertAdminUnlocked(req);
    const id = new URL(req.url).searchParams.get("id");
    deleteAgencyProfile(id);
    sqlCacheClear();
    return NextResponse.json(
      { message: "Profil de conso mutuelles supprime." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: error instanceof AdminLockError ? 403 : 400 });
  }
}
