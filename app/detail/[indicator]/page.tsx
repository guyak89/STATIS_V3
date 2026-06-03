import { DetailClient } from "@/components/detail-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function DetailPage({
  params,
}: {
  params: Promise<{ indicator: string }>;
}) {
  const { indicator } = await params;
  return (
    <Suspense fallback={null}>
      <DetailClient indicator={indicator} />
    </Suspense>
  );
}
