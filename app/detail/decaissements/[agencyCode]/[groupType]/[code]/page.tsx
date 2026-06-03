import { DecaissementsDossiersClient } from "@/components/decaissements-dossiers-client";

export default async function DecaissementsDossiersPage({
  params,
}: {
  params: Promise<{ agencyCode: string; groupType: string; code: string }>;
}) {
  const { agencyCode, groupType, code } = await params;
  return (
    <DecaissementsDossiersClient agencyCode={agencyCode} groupType={groupType} code={code} />
  );
}
