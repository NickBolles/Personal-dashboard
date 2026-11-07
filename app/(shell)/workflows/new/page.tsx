import { requirePage } from "@/server/auth/page";
import { WorkflowBuilderEntry } from "@/components/workflows/WorkflowBuilderEntry";

export const metadata = { title: "New workflow" };

export default async function NewWorkflowPage({ searchParams }: { searchParams: Promise<{ fromChat?: string }> }) {
  await requirePage("work.use");
  const { fromChat } = await searchParams;
  return <WorkflowBuilderEntry fromChat={typeof fromChat === "string" && fromChat ? fromChat : undefined} />;
}
