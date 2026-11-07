import { requirePage } from "@/server/auth/page";
import { decodeDecisionId, validDecisionId } from "@/lib/decision-route";
import { DecisionDetail } from "@/components/decisions/DecisionDetail";
import { Page, PageHeader, EmptyState } from "@/components/ui";

export const metadata = { title: "Decision" };

export default async function DecisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ choice?: string | string[] }>;
}) {
  await requirePage("work.use", "hermes.chat");
  const id = decodeDecisionId((await params).id);
  if (!validDecisionId(id))
    return (
      <Page>
        <PageHeader title="Decision" />
        <EmptyState title="Decision not found">That decision link is not valid.</EmptyState>
      </Page>
    );
  const { choice } = await searchParams;
  return <DecisionDetail id={id} initialChoice={typeof choice === "string" ? choice : ""} />;
}
