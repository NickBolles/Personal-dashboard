import { requirePage } from "@/server/auth/page";
import { WorkflowBuilder } from "@/components/workflows/WorkflowBuilder";

export const metadata = { title: "New workflow" };

export default async function NewWorkflowPage() {
  await requirePage("work.use");
  return <WorkflowBuilder />;
}
