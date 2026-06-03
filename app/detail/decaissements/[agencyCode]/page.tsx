import { DecaissementsAgencyClient } from "@/components/decaissements-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function DecaissementsAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <DecaissementsAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
