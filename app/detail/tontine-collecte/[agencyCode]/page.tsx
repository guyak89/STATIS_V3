import { TontineCollecteAgencyClient } from "@/components/tontine-collecte-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function TontineCollecteAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <TontineCollecteAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
