import { TransferePerteDossiersClient } from "@/components/transfere-perte-dossiers-client";

export default async function TransferePerteProductPage({
  params,
}: {
  params: Promise<{ agencyCode: string; productCode: string }>;
}) {
  const { agencyCode, productCode } = await params;
  return (
    <TransferePerteDossiersClient agencyCode={agencyCode} productCode={productCode} />
  );
}
