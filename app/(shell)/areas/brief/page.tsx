import { requirePage } from "@/server/auth/page";
import { WorkflowPage } from "@/components/smart/WorkflowPage";

export const metadata = { title: "Morning brief" };

export default async function BriefPage() {
  await requirePage("work.use");
  return <WorkflowPage kind="brief" title="Morning brief" subtitle="What's worth doing today, with today's AI spend and what you've closed lately." />;
}
