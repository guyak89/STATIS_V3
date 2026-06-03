import { TransferePerteAgencyClient } from "@/components/transfere-perte-agency-client";

export default async function TransferePerteAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return <TransferePerteAgencyClient agencyCode={agencyCode} />;
}
