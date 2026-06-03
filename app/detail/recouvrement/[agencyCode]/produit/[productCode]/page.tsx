import { RecouvrementDossiersClient } from "@/components/recouvrement-dossiers-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function RecouvrementDossiersPage({
  params,
}: {
  params: Promise<{ agencyCode: string; productCode: string }>;
}) {
  const { agencyCode, productCode } = await params;
  return (
    <Suspense fallback={null}>
      <RecouvrementDossiersClient
        agencyCode={agencyCode}
        productCode={productCode}
      />
    </Suspense>
  );
}
