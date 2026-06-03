import { EncoursEpargneAgencyClient } from "@/components/encours-epargne-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function EncoursEpargneAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <EncoursEpargneAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
