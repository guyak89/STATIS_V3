import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { AdminLockError, assertAdminUnlocked } from "@/lib/agency-profiles";
import {
  getPublicBrandingSettings,
  saveBrandingSettings,
  type BrandingSettings,
} from "@/lib/branding-settings";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const MAX_LOGO_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
]);

async function readJsonBody(req: Request): Promise<Partial<BrandingSettings>> {
  const body = await req.json().catch(() => ({}));
  return body as Partial<BrandingSettings>;
}

function isUpload(value: FormDataEntryValue | null): value is File {
  if (!value || typeof value !== "object") return false;

  return "arrayBuffer" in value
    && "size" in value
    && "type" in value;
}

function resolveLogoExtension(file: File): string {
  const fromType = ALLOWED_IMAGE_TYPES.get(file.type);
  if (fromType) return fromType;

  const fromName = path.extname(file.name).toLowerCase().replace(".", "");
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(fromName)) {
    return fromName === "jpeg" ? "jpg" : fromName;
  }

  throw new Error("Format de logo non supporte. Utilisez PNG, JPG, WEBP ou SVG.");
}

async function saveLogoFile(file: File): Promise<string> {
  if (file.size <= 0) {
    throw new Error("Le fichier logo est vide.");
  }

  if (file.size > MAX_LOGO_SIZE) {
    throw new Error("Le logo depasse la taille maximale autorisee de 5 Mo.");
  }

  const extension = resolveLogoExtension(file);
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const fileName = `statis-logo-${Date.now()}.${extension}`;
  const absolutePath = path.join(UPLOAD_DIR, fileName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(absolutePath, buffer);
  return `/uploads/${fileName}`;
}

export async function GET() {
  return NextResponse.json(getPublicBrandingSettings(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PUT(req: Request) {
  try {
    assertAdminUnlocked(req);
    const body = await readJsonBody(req);
    const settings = saveBrandingSettings(body);
    return NextResponse.json(
      { settings, message: "Parametres de branding enregistres." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: error instanceof AdminLockError ? 403 : 400 });
  }
}

export async function POST(req: Request) {
  try {
    assertAdminUnlocked(req);
    const formData = await req.formData();
    const appName = String(formData.get("appName") ?? "").trim();
    const logo = formData.get("logo");
    const logoUrl = isUpload(logo) && logo.size > 0 ? await saveLogoFile(logo) : undefined;
    const settings = saveBrandingSettings({ appName, logoUrl });

    return NextResponse.json(
      { settings, message: "Branding enregistre." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: error instanceof AdminLockError ? 403 : 400 });
  }
}
