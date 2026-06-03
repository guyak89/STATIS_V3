import { RecouvrementAgencyClient } from "@/components/recouvrement-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function RecouvrementAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <RecouvrementAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
