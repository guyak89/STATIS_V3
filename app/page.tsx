import { DashboardClient } from "@/components/dashboard-client";
import { Suspense } from "react";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <DashboardClient />
    </Suspense>
  );
}
