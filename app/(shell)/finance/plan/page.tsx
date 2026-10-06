import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { PlanView } from "./PlanView";

export const metadata = { title: "Long-term plan" };

export default function FinancePlanPage() {
  return (
    <Suspense fallback={<Spinner label="Loading plan" />}>
      <PlanView />
    </Suspense>
  );
}
