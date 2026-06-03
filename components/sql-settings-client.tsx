"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppBrandBlock } from "@/components/app-branding";
import { BrandingSettingsClient } from "@/components/branding-settings-client";

type SqlSettingsPayload = {
  server: string;
  database: string;
  user: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectionTimeout: number;
  requestTimeout: number;
  poolMax: number;
  poolMin: number;
  idleTimeoutMillis: number;
  acquireTimeoutMillis: number;
  hasPassword: boolean;
  storagePath: string;
  updatedAt: string | null;
};

type AgencySettingsPayload = {
  centralAgencyCode: string;
  includeCentralAgency: boolean;
  consoMutuellesActive?: boolean;
  activeProfile?: {
    id: string;
    name: string;
    agencyCodes: string[];
  } | null;
  storagePath: string;
  updatedAt: string | null;
};

type AgencyOption = {
  agencyCode: string;
  agencyName: string;
};

type SqlSettingsForm = Omit<SqlSettingsPayload, "hasPassword" | "storagePath" | "updatedAt"> & {
  password: string;
};

const EMPTY_FORM: SqlSettingsForm = {
  server: "",
  database: "",
  user: "",
  password: "",
  encrypt: false,
  trustServerCertificate: true,
  connectionTimeout: 30_000,
  requestTimeout: 300_000,
  poolMax: 10,
  poolMin: 1,
  idleTimeoutMillis: 60_000,
  acquireTimeoutMillis: 60_000,
};

type TestResult = {
  ok: boolean;
  elapsedMs?: number;
  error?: string;
  info?: {
    databaseName?: string;
    serverName?: string;
    serverTime?: string;
  };
};

type AdminSecurityStatus = {
  configured: boolean;
  unlocked: boolean;
};

type AgencyProfile = {
  id: string;
  name: string;
  agencyCodes: string[];
  createdAt: string;
  updatedAt: string;
};

type ProfileForm = {
  id: string | null;
  name: string;
  pin: string;
  agencyCodes: string[];
};

const EMPTY_PROFILE_FORM: ProfileForm = {
  id: null,
  name: "",
  pin: "",
  agencyCodes: [],
};

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

function toForm(settings: SqlSettingsPayload): SqlSettingsForm {
  return {
    server: settings.server,
    database: settings.database,
    user: settings.user,
    password: "",
    encrypt: settings.encrypt,
    trustServerCertificate: settings.trustServerCertificate,
    connectionTimeout: settings.connectionTimeout,
    requestTimeout: settings.requestTimeout,
    poolMax: settings.poolMax,
    poolMin: settings.poolMin,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    acquireTimeoutMillis: settings.acquireTimeoutMillis,
  };
}

export function SqlSettingsClient() {
  const [form, setForm] = useState<SqlSettingsForm>(EMPTY_FORM);
  const [meta, setMeta] = useState<SqlSettingsPayload | null>(null);
  const [agencySettings, setAgencySettings] = useState<AgencySettingsPayload | null>(null);
  const [agencyOptions, setAgencyOptions] = useState<AgencyOption[]>([]);
  const [security, setSecurity] = useState<AdminSecurityStatus | null>(null);
  const [securityLoading, setSecurityLoading] = useState(true);
  const [adminPin, setAdminPin] = useState("");
  const [newAdminPin, setNewAdminPin] = useState("");
  const [securitySaving, setSecuritySaving] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AgencyProfile[]>([]);
  const [profileForm, setProfileForm] = useState<ProfileForm>(EMPTY_PROFILE_FORM);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [agencyLoading, setAgencyLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [agencySaving, setAgencySaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agencyError, setAgencyError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [agencyMessage, setAgencyMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const settingsUnlocked = Boolean(security && (!security.configured || security.unlocked));

  useEffect(() => {
    let cancelled = false;

    async function loadSecurity() {
      setSecurityLoading(true);
      setSecurityError(null);
      try {
        const res = await fetch("/api/settings/admin-pin", { cache: "no-store" });
        const body = await parseJsonResponse<AdminSecurityStatus>(res);
        if (!cancelled) setSecurity(body);
      } catch (loadError) {
        if (!cancelled) setSecurityError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) setSecurityLoading(false);
      }
    }

    loadSecurity();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!settingsUnlocked) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function loadSettings() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/settings/sql", { cache: "no-store" });
        const settings = await parseJsonResponse<SqlSettingsPayload>(res);
        if (cancelled) return;
        setMeta(settings);
        setForm(toForm(settings));
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSettings();
    return () => { cancelled = true; };
  }, [settingsUnlocked]);

  useEffect(() => {
    if (!settingsUnlocked) {
      setAgencyLoading(false);
      return;
    }
    let cancelled = false;

    async function loadAgencySettings() {
      setAgencyLoading(true);
      setAgencyError(null);
      try {
        const res = await fetch("/api/settings/agence-faitiere", { cache: "no-store" });
        const body = await parseJsonResponse<{
          settings: AgencySettingsPayload;
          agencies: AgencyOption[];
        }>(res);
        if (cancelled) return;
        setAgencySettings(body.settings);
        setAgencyOptions(body.agencies);
      } catch (loadError) {
        if (!cancelled) {
          setAgencyError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) setAgencyLoading(false);
      }
    }

    loadAgencySettings();
    return () => { cancelled = true; };
  }, [settingsUnlocked]);

  useEffect(() => {
    if (!settingsUnlocked) return;
    let cancelled = false;

    async function loadProfiles() {
      setProfileError(null);
      try {
        const res = await fetch("/api/settings/agency-profiles", { cache: "no-store" });
        const body = await parseJsonResponse<{
          profiles: AgencyProfile[];
          agencies: AgencyOption[];
        }>(res);
        if (cancelled) return;
        setProfiles(body.profiles);
        if (body.agencies.length > 0) setAgencyOptions(body.agencies);
      } catch (loadError) {
        if (!cancelled) setProfileError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }

    loadProfiles();
    return () => { cancelled = true; };
  }, [settingsUnlocked]);

  function updateText(field: keyof SqlSettingsForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateNumber(field: keyof SqlSettingsForm, value: string) {
    setForm((current) => ({ ...current, [field]: Number(value) }));
  }

  function updateBoolean(field: keyof SqlSettingsForm, value: boolean) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function unlockSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSecuritySaving(true);
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      const res = await fetch("/api/settings/admin-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: adminPin }),
      });
      const body = await parseJsonResponse<AdminSecurityStatus & { message?: string }>(res);
      setSecurity({ configured: body.configured, unlocked: body.unlocked });
      setSecurityMessage(body.message ?? "Parametrage deverrouille.");
      setAdminPin("");
    } catch (unlockError) {
      setSecurityError(unlockError instanceof Error ? unlockError.message : String(unlockError));
    } finally {
      setSecuritySaving(false);
    }
  }

  async function saveAdminPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSecuritySaving(true);
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      const res = await fetch("/api/settings/admin-pin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: newAdminPin }),
      });
      const body = await parseJsonResponse<AdminSecurityStatus & { message?: string }>(res);
      setSecurity({ configured: body.configured, unlocked: body.unlocked });
      setSecurityMessage(body.message ?? "PIN administrateur enregistre.");
      setNewAdminPin("");
    } catch (saveError) {
      setSecurityError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSecuritySaving(false);
    }
  }

  function toggleProfileAgency(agencyCode: string, checked: boolean) {
    setProfileForm((current) => ({
      ...current,
      agencyCodes: checked
        ? Array.from(new Set([...current.agencyCodes, agencyCode])).sort()
        : current.agencyCodes.filter((code) => code !== agencyCode),
    }));
  }

  function editProfile(profile: AgencyProfile) {
    setProfileForm({
      id: profile.id,
      name: profile.name,
      pin: "",
      agencyCodes: profile.agencyCodes,
    });
    setProfileMessage(null);
    setProfileError(null);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileSaving(true);
    setProfileError(null);
    setProfileMessage(null);
    try {
      const res = await fetch("/api/settings/agency-profiles", {
        method: profileForm.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profileForm),
      });
      const body = await parseJsonResponse<{ profile: AgencyProfile; message: string }>(res);
      setProfiles((current) => {
        const without = current.filter((profile) => profile.id !== body.profile.id);
        return [...without, body.profile].sort((a, b) => a.name.localeCompare(b.name));
      });
      setProfileForm(EMPTY_PROFILE_FORM);
      setProfileMessage(body.message);
    } catch (saveError) {
      setProfileError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setProfileSaving(false);
    }
  }

  async function removeProfile(profileId: string) {
    setProfileSaving(true);
    setProfileError(null);
    setProfileMessage(null);
    try {
      const res = await fetch(`/api/settings/agency-profiles?id=${encodeURIComponent(profileId)}`, {
        method: "DELETE",
      });
      const body = await parseJsonResponse<{ message: string }>(res);
      setProfiles((current) => current.filter((profile) => profile.id !== profileId));
      setProfileForm((current) => current.id === profileId ? EMPTY_PROFILE_FORM : current);
      setProfileMessage(body.message);
    } catch (deleteError) {
      setProfileError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setProfileSaving(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/sql", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await parseJsonResponse<{ settings: SqlSettingsPayload; message: string }>(res);
      setMeta(body.settings);
      setForm(toForm(body.settings));
      setMessage(body.message);
      setTestResult(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setError(null);
    setMessage(null);
    setTestResult(null);

    try {
      const res = await fetch("/api/settings/sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await parseJsonResponse<TestResult>(res);
      setTestResult(body);
    } catch (testError) {
      setTestResult({
        ok: false,
        error: testError instanceof Error ? testError.message : String(testError),
      });
    } finally {
      setTesting(false);
    }
  }

  async function saveAgencySettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAgencySaving(true);
    setAgencyError(null);
    setAgencyMessage(null);

    try {
      const res = await fetch("/api/settings/agence-faitiere", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          centralAgencyCode: agencySettings?.centralAgencyCode ?? "",
          includeCentralAgency: agencySettings?.includeCentralAgency ?? false,
        }),
      });
      const body = await parseJsonResponse<{ settings: AgencySettingsPayload; message: string }>(res);
      setAgencySettings(body.settings);
      setAgencyMessage(body.message);
    } catch (saveError) {
      setAgencyError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setAgencySaving(false);
    }
  }

  if (securityLoading) {
    return (
      <div className="app">
        <header className="app-header">
          <Link href="/" className="back-btn">Retour</Link>
          <div className="header-sep" />
          <AppBrandBlock sub="Parametrage de l'application" />
        </header>
        <main className="app-content">
          <div className="skeleton-panel" />
        </main>
      </div>
    );
  }

  if (security?.configured && !security.unlocked) {
    return (
      <div className="app">
        <header className="app-header">
          <Link href="/" className="back-btn">Retour</Link>
          <div className="header-sep" />
          <AppBrandBlock sub="Parametrage verrouille" />
        </header>
        <main className="app-content">
          <form className="settings-panel" onSubmit={unlockSettings}>
            <div className="settings-section-title">
              <div>
                <p className="settings-kicker">Securite</p>
                <h2>PIN administrateur requis</h2>
              </div>
            </div>
            {securityError && <div className="settings-alert error">{securityError}</div>}
            {securityMessage && <div className="settings-alert success">{securityMessage}</div>}
            <div className="settings-grid">
              <label className="settings-field">
                <span>PIN administrateur</span>
                <input
                  value={adminPin}
                  onChange={(event) => setAdminPin(event.target.value)}
                  type="password"
                  autoFocus
                  disabled={securitySaving}
                />
              </label>
            </div>
            <div className="settings-actions">
              <button type="submit" className="settings-primary-btn" disabled={securitySaving}>
                {securitySaving ? "Verification..." : "Deverrouiller le parametrage"}
              </button>
            </div>
          </form>
        </main>
      </div>
    );
  }

  const disabled = loading || saving || testing;
  const agencyDisabled = agencyLoading || agencySaving;

  return (
    <div className="app">
      <header className="app-header">
        <Link href="/" className="back-btn">Retour</Link>
        <div className="header-sep" />
        <AppBrandBlock sub="Parametrage de l'application" />
      </header>

      <main className="app-content">
        <section className="settings-hero">
          <div>
            <p className="settings-kicker">Parametrage local</p>
            <h1>Identite et connexion SQL</h1>
            <p>
              Le nom, le logo, l&apos;agence faitiere et la connexion SQL sont stockes dans un fichier SQLite local.
              Les valeurs SQL remplacent
              les valeurs de `.env.local` au runtime. Le mot de passe n&apos;est
              jamais renvoye par l&apos;API.
            </p>
          </div>
          <div className="settings-file-card">
            <span>Fichier SQLite</span>
            <strong>{meta?.storagePath ?? "Chargement..."}</strong>
            <small>Derniere mise a jour : {meta?.updatedAt ?? "initialisation"}</small>
          </div>
        </section>

        <form className="settings-panel" onSubmit={saveAdminPin}>
          <div className="settings-section-title">
            <div>
              <p className="settings-kicker">Securite du parametrage</p>
              <h2>PIN administrateur</h2>
            </div>
          </div>
          {securityError && <div className="settings-alert error">{securityError}</div>}
          {securityMessage && <div className="settings-alert success">{securityMessage}</div>}
          <div className="settings-grid">
            <label className="settings-field">
              <span>{security?.configured ? "Nouveau PIN administrateur" : "Definir le PIN administrateur"}</span>
              <input
                value={newAdminPin}
                onChange={(event) => setNewAdminPin(event.target.value)}
                type="password"
                placeholder="Minimum 4 caracteres"
                disabled={securitySaving}
              />
            </label>
            <div className="settings-info-card">
              <span>Portee</span>
              <strong>{security?.configured ? "Parametrage protege" : "Pas encore protege"}</strong>
              <small>Ce PIN verrouille l&apos;acces a cette page de parametrage general.</small>
            </div>
          </div>
          <div className="settings-actions">
            <button type="submit" className="settings-primary-btn" disabled={securitySaving}>
              {securitySaving ? "Enregistrement..." : "Enregistrer le PIN administrateur"}
            </button>
          </div>
        </form>

        <BrandingSettingsClient />

        <form className="settings-panel" onSubmit={saveAgencySettings}>
          <div className="settings-section-title">
            <div>
              <p className="settings-kicker">Parametrage reseau</p>
              <h2>Agence faitiere</h2>
            </div>
          </div>

          {agencyError && <div className="settings-alert error">{agencyError}</div>}
          {agencyMessage && <div className="settings-alert success">{agencyMessage}</div>}
          {agencySettings?.consoMutuellesActive && (
            <div className="settings-alert success">
              Conso mutuelles active avec le profil {agencySettings.activeProfile?.name}. L&apos;integration faitiere est forcee a non.
            </div>
          )}

          <div className="settings-grid">
            <label className="settings-field">
              <span>Code agence faitiere</span>
              <select
                value={agencySettings?.centralAgencyCode ?? ""}
                onChange={(event) => {
                  const centralAgencyCode = event.target.value;
                  setAgencySettings((current) => current
                    ? { ...current, centralAgencyCode }
                    : {
                        centralAgencyCode,
                        includeCentralAgency: false,
                        storagePath: "",
                        updatedAt: null,
                      });
                }}
                disabled={agencyDisabled || agencySettings?.consoMutuellesActive}
              >
                <option value="">Aucune agence faitiere definie</option>
                {agencyOptions.map((agency) => (
                  <option key={agency.agencyCode} value={agency.agencyCode}>
                    {agency.agencyCode} - {agency.agencyName}
                  </option>
                ))}
              </select>
            </label>

            <div className="settings-info-card">
              <span>Valeur par defaut</span>
              <strong>{agencySettings?.consoMutuellesActive ? "Desactive par profil conso" : "Ne pas integrer la faitiere"}</strong>
              <small>
                {agencySettings?.consoMutuellesActive
                  ? "Le perimetre est limite aux agences du profil actif."
                  : "La case de la page d'accueil reste decochee par defaut et ce choix est stocke ici."}
              </small>
            </div>
          </div>

          <div className="settings-actions">
            <button type="submit" className="settings-primary-btn" disabled={agencyDisabled || agencySettings?.consoMutuellesActive}>
              {agencySaving ? "Enregistrement..." : "Enregistrer l'agence faitiere"}
            </button>
          </div>
        </form>

        <form className="settings-panel" onSubmit={saveProfile}>
          <div className="settings-section-title">
            <div>
              <p className="settings-kicker">Conso mutuelles</p>
              <h2>Profils de perimetre agences</h2>
            </div>
          </div>

          {profileError && <div className="settings-alert error">{profileError}</div>}
          {profileMessage && <div className="settings-alert success">{profileMessage}</div>}

          <div className="settings-grid">
            <label className="settings-field">
              <span>Nom du profil</span>
              <input
                value={profileForm.name}
                onChange={(event) => setProfileForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Zone Nord, Audit, Direction..."
                disabled={profileSaving}
              />
            </label>
            <label className="settings-field">
              <span>{profileForm.id ? "Nouveau PIN du profil (optionnel)" : "PIN du profil"}</span>
              <input
                value={profileForm.pin}
                onChange={(event) => setProfileForm((current) => ({ ...current, pin: event.target.value }))}
                placeholder={profileForm.id ? "Laisser vide pour conserver" : "PIN requis"}
                type="password"
                disabled={profileSaving}
              />
            </label>
          </div>

          <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
            <span style={{ color: "var(--text-muted)", fontWeight: 800 }}>Agences du profil</span>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 8,
              maxHeight: 280,
              overflow: "auto",
              padding: 10,
              border: "1px solid var(--border-md)",
              borderRadius: 8,
              background: "var(--surface-2)",
            }}>
              {agencyOptions.map((agency) => (
                <label key={agency.agencyCode} className="settings-switch" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={profileForm.agencyCodes.includes(agency.agencyCode)}
                    onChange={(event) => toggleProfileAgency(agency.agencyCode, event.target.checked)}
                    disabled={profileSaving}
                  />
                  <span>{agency.agencyCode} - {agency.agencyName}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="settings-actions">
            {profileForm.id && (
              <button
                type="button"
                className="refresh-btn"
                onClick={() => setProfileForm(EMPTY_PROFILE_FORM)}
                disabled={profileSaving}
              >
                Annuler modification
              </button>
            )}
            <button type="submit" className="settings-primary-btn" disabled={profileSaving}>
              {profileSaving ? "Enregistrement..." : profileForm.id ? "Enregistrer le profil" : "Creer le profil"}
            </button>
          </div>

          <div style={{ overflowX: "auto", marginTop: 18 }}>
            <table>
              <thead>
                <tr>
                  <th>Profil</th>
                  <th>Agences</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>
                      <span className="collector-name">
                        <strong>{profile.name}</strong>
                        <span>{profile.agencyCodes.length} agence(s)</span>
                      </span>
                    </td>
                    <td style={{ color: "var(--text-muted)" }}>{profile.agencyCodes.join(", ")}</td>
                    <td className="td-num" style={{ textAlign: "right" }}>
                      <button type="button" className="refresh-btn" onClick={() => editProfile(profile)} disabled={profileSaving}>
                        Modifier
                      </button>
                      <button type="button" className="refresh-btn" onClick={() => removeProfile(profile.id)} disabled={profileSaving}>
                        Supprimer
                      </button>
                    </td>
                  </tr>
                ))}
                {profiles.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                      Aucun profil de conso mutuelles defini.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </form>

        <form className="settings-panel" onSubmit={saveSettings}>
          <div className="settings-section-title">
            <div>
              <p className="settings-kicker">Connexion base Perfect</p>
              <h2>Parametres SQL Server</h2>
            </div>
          </div>

          {error && <div className="settings-alert error">{error}</div>}
          {message && <div className="settings-alert success">{message}</div>}
          {testResult && (
            <div className={`settings-alert ${testResult.ok ? "success" : "error"}`}>
              {testResult.ok
                ? `Connexion reussie en ${testResult.elapsedMs ?? 0} ms sur ${testResult.info?.serverName ?? "SQL Server"} / ${testResult.info?.databaseName ?? form.database}.`
                : testResult.error}
            </div>
          )}

          <div className="settings-grid">
            <label className="settings-field">
              <span>Serveur SQL</span>
              <input
                value={form.server}
                onChange={(event) => updateText("server", event.target.value)}
                placeholder="localhost\\SQL2022 ou 173.208.241.183,1433"
                disabled={disabled}
                required
              />
            </label>

            <label className="settings-field">
              <span>Base de donnees</span>
              <input
                value={form.database}
                onChange={(event) => updateText("database", event.target.value)}
                placeholder="BASE_INTERCO"
                disabled={disabled}
                required
              />
            </label>

            <label className="settings-field">
              <span>Utilisateur</span>
              <input
                value={form.user}
                onChange={(event) => updateText("user", event.target.value)}
                placeholder="sa"
                disabled={disabled}
                required
              />
            </label>

            <label className="settings-field">
              <span>Mot de passe</span>
              <input
                value={form.password}
                onChange={(event) => updateText("password", event.target.value)}
                placeholder={meta?.hasPassword ? "Laisser vide pour conserver" : "Mot de passe SQL"}
                disabled={disabled}
                type="password"
              />
            </label>
          </div>

          <div className="settings-switch-row">
            <label className="settings-switch">
              <input
                type="checkbox"
                checked={form.encrypt}
                onChange={(event) => updateBoolean("encrypt", event.target.checked)}
                disabled={disabled}
              />
              <span>Chiffrement SQL active</span>
            </label>

            <label className="settings-switch">
              <input
                type="checkbox"
                checked={form.trustServerCertificate}
                onChange={(event) => updateBoolean("trustServerCertificate", event.target.checked)}
                disabled={disabled}
              />
              <span>Faire confiance au certificat serveur</span>
            </label>
          </div>

          <div className="settings-grid compact">
            <label className="settings-field">
              <span>Timeout connexion (ms)</span>
              <input
                type="number"
                min={1000}
                value={form.connectionTimeout}
                onChange={(event) => updateNumber("connectionTimeout", event.target.value)}
                disabled={disabled}
              />
            </label>

            <label className="settings-field">
              <span>Timeout requete (ms)</span>
              <input
                type="number"
                min={1000}
                value={form.requestTimeout}
                onChange={(event) => updateNumber("requestTimeout", event.target.value)}
                disabled={disabled}
              />
            </label>

            <label className="settings-field">
              <span>Pool min</span>
              <input
                type="number"
                min={0}
                value={form.poolMin}
                onChange={(event) => updateNumber("poolMin", event.target.value)}
                disabled={disabled}
              />
            </label>

            <label className="settings-field">
              <span>Pool max</span>
              <input
                type="number"
                min={1}
                value={form.poolMax}
                onChange={(event) => updateNumber("poolMax", event.target.value)}
                disabled={disabled}
              />
            </label>
          </div>

          <div className="settings-grid compact">
            <label className="settings-field">
              <span>Idle timeout pool (ms)</span>
              <input
                type="number"
                min={1000}
                value={form.idleTimeoutMillis}
                onChange={(event) => updateNumber("idleTimeoutMillis", event.target.value)}
                disabled={disabled}
              />
            </label>

            <label className="settings-field">
              <span>Acquire timeout pool (ms)</span>
              <input
                type="number"
                min={1000}
                value={form.acquireTimeoutMillis}
                onChange={(event) => updateNumber("acquireTimeoutMillis", event.target.value)}
                disabled={disabled}
              />
            </label>
          </div>

          <div className="settings-actions">
            <button type="button" className="refresh-btn" onClick={testConnection} disabled={disabled}>
              {testing ? "Test en cours..." : "Tester la connexion"}
            </button>
            <button type="submit" className="settings-primary-btn" disabled={disabled}>
              {saving ? "Enregistrement..." : "Enregistrer"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
