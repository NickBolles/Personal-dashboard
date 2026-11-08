import { Suspense } from "react";
import { KSpinner } from "@/components/ui";
import { PlanView } from "./PlanView";

export const metadata = { title: "Long-term plan" };

export default function FinancePlanPage() {
  return (
    <Suspense
      fallback={
        <span role="status" className="inline-flex items-center gap-2">
          <KSpinner />
          <span>Loading plan</span>
        </span>
      }
    >
      <PlanView />
    </Suspense>
  );
}
