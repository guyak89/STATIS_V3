import { OperationsCaisseAgencyClient } from "@/components/operations-caisse-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function OperationsCaisseAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <OperationsCaisseAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
