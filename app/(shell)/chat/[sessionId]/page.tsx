import { redirect } from "next/navigation";
import { requirePage } from "@/server/auth/page";
import { globalCoordinatorArea, pinnedCoordinatorSession } from "@/server/work/coordinator";
import { Conversation } from "@/components/chat/Conversation";

export const metadata = { title: "Conversation" };

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ sessionId: string }>; searchParams: Promise<{ run?: string }> }) {
  const user = await requirePage("hermes.chat");
  const { sessionId } = await params;
  const { run } = await searchParams;
  const id = decodeURIComponent(sessionId);
  // The pinned Chief of staff thread is shown in one place, the Chief of staff itself: never a second, different copy.
  // Only while it is the thread shown there: a pinned conversation that was archived or moved out of the area is an
  // ordinary conversation again and keeps its own page.
  const chief = user.capabilities.has("work.use") ? globalCoordinatorArea(user) : null;
  if (chief && pinnedCoordinatorSession(user, chief.id) === id) redirect("/chief");
  return <Conversation sessionId={id} initialRunId={run} />;
}
