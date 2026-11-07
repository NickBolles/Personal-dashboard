import { requirePage } from "@/server/auth/page";
import { WorkflowBuilderEntry } from "@/components/workflows/WorkflowBuilderEntry";

export const metadata = { title: "Edit workflow" };

export default async function EditWorkflowPage({ params }: { params: Promise<{ slug: string }> }) {
  await requirePage("work.use");
  const { slug } = await params;
  return <WorkflowBuilderEntry slug={slug} />;
}
