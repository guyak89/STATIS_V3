"use client";

import { FormEvent, useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { DEFAULT_BRANDING, type BrandingSettingsPayload } from "@/components/app-branding";

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export function BrandingSettingsClient() {
  const { mutate } = useSWRConfig();
  const [appName, setAppName] = useState(DEFAULT_BRANDING.appName);
  const [logoUrl, setLogoUrl] = useState(DEFAULT_BRANDING.logoUrl);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState(DEFAULT_BRANDING.logoUrl);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadBranding() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/settings/branding", { cache: "no-store" });
        const settings = await parseJsonResponse<BrandingSettingsPayload>(res);
        if (cancelled) return;
        setAppName(settings.appName || DEFAULT_BRANDING.appName);
        setLogoUrl(settings.logoUrl || DEFAULT_BRANDING.logoUrl);
        setPreviewUrl(settings.logoUrl || DEFAULT_BRANDING.logoUrl);
        setStoragePath(settings.storagePath ?? null);
        setUpdatedAt(settings.updatedAt ?? null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadBranding();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!logoFile) {
      setPreviewUrl(logoUrl || DEFAULT_BRANDING.logoUrl);
      return;
    }

    const objectUrl = URL.createObjectURL(logoFile);
    setPreviewUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [logoFile, logoUrl]);

  async function saveBranding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.set("appName", appName);
      if (logoFile) formData.set("logo", logoFile);

      const res = await fetch("/api/settings/branding", {
        method: "POST",
        body: formData,
      });
      const body = await parseJsonResponse<{ settings: BrandingSettingsPayload; message: string }>(res);
      setAppName(body.settings.appName);
      setLogoUrl(body.settings.logoUrl);
      setPreviewUrl(body.settings.logoUrl);
      setStoragePath(body.settings.storagePath ?? null);
      setUpdatedAt(body.settings.updatedAt ?? null);
      setLogoFile(null);
      setMessage(body.message);
      mutate("/api/settings/branding", body.settings, { revalidate: false });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving;

  return (
    <form className="settings-panel branding-settings-panel" onSubmit={saveBranding}>
      <div className="settings-section-title">
        <div>
          <p className="settings-kicker">Identite application</p>
          <h2>Nom et logo</h2>
        </div>
        <span className="settings-pill">SQLite local</span>
      </div>

      {error && <div className="settings-alert error">{error}</div>}
      {message && <div className="settings-alert success">{message}</div>}

      <div className="branding-settings-grid">
        <div className="branding-preview-card">
          <div
            className="branding-preview-logo"
            style={{ backgroundImage: previewUrl ? `url(${previewUrl})` : undefined }}
            aria-label={`Logo ${appName || DEFAULT_BRANDING.appName}`}
          />
          <div>
            <strong>{appName || DEFAULT_BRANDING.appName}</strong>
            <span>Logo actif dans les entetes du tableau de bord</span>
          </div>
        </div>

        <div className="branding-form-fields">
          <label className="settings-field">
            <span>Nom application</span>
            <input
              value={appName}
              onChange={(event) => setAppName(event.target.value)}
              disabled={disabled}
              placeholder="STATIS"
              required
            />
          </label>

          <label className="settings-field">
            <span>Logo</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)}
              disabled={disabled}
            />
          </label>

          <div className="settings-meta-line">
            <span>Fichier SQLite : {storagePath ?? "Chargement..."}</span>
            <span>Derniere mise a jour : {updatedAt ?? "initialisation"}</span>
          </div>
        </div>
      </div>

      <div className="settings-actions">
        <button type="submit" className="settings-primary-btn" disabled={disabled}>
          {saving ? "Enregistrement..." : "Enregistrer le branding"}
        </button>
      </div>
    </form>
  );
}
