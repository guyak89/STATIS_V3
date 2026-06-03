import { ResultatAgencyClient } from "@/components/resultat-agency-client";

export default async function ResultatAgencyPage({
  params,
}: {
  params: Promise<{ agencyCode: string }>;
}) {
  const { agencyCode } = await params;
  return <ResultatAgencyClient agencyCode={agencyCode} />;
}
