import { requirePage } from "@/server/auth/page";
import { WorkflowBuilder } from "@/components/workflows/WorkflowBuilder";

export const metadata = { title: "New workflow" };

export default async function NewWorkflowPage({ searchParams }: { searchParams: Promise<{ fromChat?: string }> }) {
  await requirePage("work.use");
  const { fromChat } = await searchParams;
  return <WorkflowBuilder fromChat={typeof fromChat === "string" && fromChat ? fromChat : undefined} />;
}
