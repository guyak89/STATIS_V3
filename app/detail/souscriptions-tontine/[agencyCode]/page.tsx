import { SouscriptionsTontineAgencyClient } from "@/components/souscriptions-tontine-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function SouscriptionsTontineAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <SouscriptionsTontineAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
