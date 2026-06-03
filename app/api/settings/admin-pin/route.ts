import { NextResponse } from "next/server";
import {
  adminCookieOptions,
  adminUnlockCookieValue,
  ADMIN_UNLOCK_COOKIE,
  isAdminPinConfigured,
  isAdminUnlocked,
  saveAdminPin,
  verifyAdminPin,
} from "@/lib/agency-profiles";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function readBody(req: Request) {
  return req.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export async function GET() {
  return NextResponse.json(
    {
      configured: isAdminPinConfigured(),
      // L'interface doit redemander le PIN a chaque entree dans Parametres.
      // Le cookie reste utilise uniquement pour autoriser les mutations apres saisie.
      unlocked: false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    verifyAdminPin(body.pin);
    const res = NextResponse.json(
      { configured: true, unlocked: true, message: "Parametrage deverrouille." },
      { headers: { "Cache-Control": "no-store" } },
    );
    res.cookies.set(ADMIN_UNLOCK_COOKIE, adminUnlockCookieValue(), adminCookieOptions);
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 403 });
  }
}

export async function PUT(req: Request) {
  try {
    if (isAdminPinConfigured() && !isAdminUnlocked(req)) {
      return NextResponse.json({ error: "Parametrage verrouille." }, { status: 403 });
    }
    const body = await readBody(req);
    saveAdminPin(body.pin);
    const res = NextResponse.json(
      { configured: true, unlocked: true, message: "PIN administrateur enregistre." },
      { headers: { "Cache-Control": "no-store" } },
    );
    res.cookies.set(ADMIN_UNLOCK_COOKIE, adminUnlockCookieValue(), adminCookieOptions);
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
