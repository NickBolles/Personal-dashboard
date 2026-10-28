import { requirePage } from "@/server/auth/page";
import { WorkflowPage } from "@/components/smart/WorkflowPage";

export const metadata = { title: "Plan the week" };

export default async function PlanPage() {
  await requirePage("work.use");
  return <WorkflowPage kind="week" title="Plan the week" subtitle="Time blocks for this week's tasks around your calendar. Drag to move; nothing changes until you apply." />;
}
