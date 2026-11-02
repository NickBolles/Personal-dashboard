import { requirePage } from "@/server/auth/page";
import { WorkflowBuilder } from "@/components/workflows/WorkflowBuilder";

export const metadata = { title: "Edit workflow" };

export default async function EditWorkflowPage({ params }: { params: Promise<{ slug: string }> }) {
  await requirePage("work.use");
  const { slug } = await params;
  return <WorkflowBuilder slug={slug} />;
}
