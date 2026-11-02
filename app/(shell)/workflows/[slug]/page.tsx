import { requirePage } from "@/server/auth/page";
import { WorkflowDetail } from "@/components/workflows/WorkflowDetail";

export const metadata = { title: "Workflow" };

/** Workflow page: session history, stats (plain counts) and the opt-in reminder. */
export default async function WorkflowPage({ params }: { params: Promise<{ slug: string }> }) {
  await requirePage("work.use");
  const { slug } = await params;
  return <WorkflowDetail slug={slug} />;
}
