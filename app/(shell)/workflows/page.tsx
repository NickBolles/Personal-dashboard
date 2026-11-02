import { requirePage } from "@/server/auth/page";
import { WorkflowsGallery } from "@/components/workflows/WorkflowsGallery";

export const metadata = { title: "Workflows" };

export default async function WorkflowsPage() {
  await requirePage("work.use");
  return <WorkflowsGallery />;
}
