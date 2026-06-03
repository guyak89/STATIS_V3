import { NextResponse } from "next/server";
import {
  activeProfileCookieValue,
  ACTIVE_PROFILE_COOKIE,
  getActiveProfileFromRequest,
  profileCookieOptions,
  verifyProfilePin,
} from "@/lib/agency-profiles";
import { sqlCacheClear } from "@/lib/sql-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function readBody(req: Request) {
  return req.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export async function GET(req: Request) {
  return NextResponse.json(
    { activeProfile: getActiveProfileFromRequest(req) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const profile = verifyProfilePin(body.profileId, body.pin);
    sqlCacheClear();
    const res = NextResponse.json(
      {
        activeProfile: {
          id: profile.id,
          name: profile.name,
          agencyCodes: profile.agencyCodes,
        },
        message: "Profil de conso mutuelles active.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    res.cookies.set(ACTIVE_PROFILE_COOKIE, activeProfileCookieValue(profile.id), profileCookieOptions);
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 403 });
  }
}

export async function DELETE(req: Request) {
  try {
    const activeProfile = getActiveProfileFromRequest(req);
    if (!activeProfile) {
      return NextResponse.json({ error: "Aucun profil actif." }, { status: 400 });
    }
    const body = await readBody(req);
    verifyProfilePin(activeProfile.id, body.pin);
    sqlCacheClear();
    const res = NextResponse.json(
      { activeProfile: null, message: "Profil de conso mutuelles desactive." },
      { headers: { "Cache-Control": "no-store" } },
    );
    res.cookies.set(ACTIVE_PROFILE_COOKIE, "", { ...profileCookieOptions, maxAge: 0 });
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 403 });
  }
}
