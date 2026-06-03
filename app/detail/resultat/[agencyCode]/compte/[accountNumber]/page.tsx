import { ResultatLedgerClient } from "@/components/resultat-ledger-client";

export default async function ResultatLedgerPage({
  params,
}: {
  params: Promise<{ agencyCode: string; accountNumber: string }>;
}) {
  const { agencyCode, accountNumber } = await params;
  return <ResultatLedgerClient agencyCode={agencyCode} accountNumber={accountNumber} />;
}
