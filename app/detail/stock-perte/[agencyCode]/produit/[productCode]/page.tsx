import { StockPerteDossiersClient } from "@/components/stock-perte-dossiers-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function StockPerteProductPage({
  params,
}: {
  params: Promise<{ agencyCode: string; productCode: string }>;
}) {
  const { agencyCode, productCode } = await params;
  return (
    <Suspense fallback={null}>
      <StockPerteDossiersClient agencyCode={agencyCode} productCode={productCode} />
    </Suspense>
  );
}
