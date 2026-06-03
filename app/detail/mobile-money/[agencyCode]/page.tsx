import { MobileMoneyAgencyClient } from "@/components/mobile-money-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function MobileMoneyAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <MobileMoneyAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
