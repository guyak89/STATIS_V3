import { OperationsCaisseOperationListClient } from "@/components/operations-caisse-operation-list-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function OperationsCaisseOperationListPage({
  params,
}: {
  params: Promise<{ agencyCode: string; cashDeskKey: string; categoryCode: string }>;
}) {
  const { agencyCode, cashDeskKey, categoryCode } = await params;
  return (
    <Suspense fallback={null}>
      <OperationsCaisseOperationListClient
        agencyCode={agencyCode}
        cashDeskKey={cashDeskKey}
        categoryCode={categoryCode}
      />
    </Suspense>
  );
}
