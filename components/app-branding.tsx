"use client";

import Image from "next/image";
import { useState } from "react";
import useSWR from "swr";

export type BrandingSettingsPayload = {
  appName: string;
  logoUrl: string;
  storagePath?: string;
  updatedAt?: string | null;
};

export const DEFAULT_BRANDING: BrandingSettingsPayload = {
  appName: "STATIS",
  logoUrl: "/uploads/logo-urclec.png",
};

async function fetchBranding(url: string): Promise<BrandingSettingsPayload> {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  return body as BrandingSettingsPayload;
}

export function useBranding(): BrandingSettingsPayload {
  const { data } = useSWR("/api/settings/branding", fetchBranding, {
    dedupingInterval: 60_000,
    revalidateOnFocus: false,
  });

  return data ?? DEFAULT_BRANDING;
}

function BrandLogo({
  appName,
  fallback,
  logoUrl,
}: {
  appName: string;
  fallback: string;
  logoUrl: string;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const imageFailed = failedLogoUrl === logoUrl;

  if (logoUrl && !imageFailed) {
    return (
      <div className="brand-logo brand-logo-image">
        <Image
          src={logoUrl}
          alt={`Logo ${appName}`}
          width={34}
          height={34}
          unoptimized
          onError={() => setFailedLogoUrl(logoUrl)}
        />
      </div>
    );
  }

  return <div className="brand-logo">{fallback}</div>;
}

export function AppBrandBlock({
  sub,
  fallback = "ST",
}: {
  sub?: string;
  fallback?: string;
}) {
  const branding = useBranding();
  const appName = branding.appName || DEFAULT_BRANDING.appName;

  return (
    <div className="header-brand">
      <BrandLogo appName={appName} fallback={fallback} logoUrl={branding.logoUrl} />
      <div>
        <div className="brand-name">{appName}</div>
        {sub ? <div className="brand-sub">{sub}</div> : null}
      </div>
    </div>
  );
}

export function AppName() {
  const branding = useBranding();
  return <>{branding.appName || DEFAULT_BRANDING.appName}</>;
}
