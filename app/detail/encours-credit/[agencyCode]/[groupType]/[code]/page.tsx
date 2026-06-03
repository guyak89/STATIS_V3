import { EncoursCreditDossiersClient } from "@/components/encours-credit-dossiers-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function EncoursCreditDossiersPage({
  params,
}: {
  params: Promise<{ agencyCode: string; groupType: string; code: string }>;
}) {
  const { agencyCode, groupType, code } = await params;
  return (
    <Suspense fallback={null}>
      <EncoursCreditDossiersClient
        agencyCode={agencyCode}
        groupType={groupType}
        code={code}
      />
    </Suspense>
  );
}
