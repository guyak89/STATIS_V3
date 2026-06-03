import { ImpayesClient } from "@/components/impayes-rapport-client";
import { Suspense } from "react";

export default async function ImpayesPage({
  params,
}: {
  params: Promise<{ agence: string }>;
}) {
  const { agence } = await params;
  return (
    <Suspense fallback={null}>
      <ImpayesClient agence={agence.toUpperCase()} />
    </Suspense>
  );
}
