import { OperationsCaisseCashDeskClient } from "@/components/operations-caisse-cashdesk-client";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function OperationsCaisseCashDeskPage({
  params,
}: {
  params: Promise<{ agencyCode: string; cashDeskKey: string }>;
}) {
  const { agencyCode, cashDeskKey } = await params;
  return (
    <Suspense fallback={null}>
      <OperationsCaisseCashDeskClient agencyCode={agencyCode} cashDeskKey={cashDeskKey} />
    </Suspense>
  );
}
