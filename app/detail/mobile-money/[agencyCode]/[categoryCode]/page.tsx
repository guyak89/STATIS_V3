import { MobileMoneyOperationListClient } from "@/components/mobile-money-operation-list-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function MobileMoneyCategoryPage({
  params,
}: {
  params: Promise<{ agencyCode: string; categoryCode: string }>;
}) {
  const { agencyCode, categoryCode } = await params;
  return (
    <Suspense fallback={null}>
      <MobileMoneyOperationListClient agencyCode={agencyCode} categoryCode={categoryCode} />
    </Suspense>
  );
}
