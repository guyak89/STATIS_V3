import { StockPerteAgencyClient } from "@/components/stock-perte-agency-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function StockPerteAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return (
    <Suspense fallback={null}>
      <StockPerteAgencyClient agencyCode={agencyCode} />
    </Suspense>
  );
}
