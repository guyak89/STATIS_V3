import { EncoursCreditAgencyClient } from "@/components/encours-credit-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function EncoursCreditAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <EncoursCreditAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
