import { redirect } from "next/navigation";
import { requirePage } from "@/server/auth/page";
import { coordinatorPin, globalCoordinatorArea } from "@/server/work/coordinator";
import { Conversation } from "@/components/chat/Conversation";

export const metadata = { title: "Conversation" };

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ sessionId: string }>; searchParams: Promise<{ run?: string }> }) {
  const user = await requirePage("hermes.chat");
  const { sessionId } = await params;
  const { run } = await searchParams;
  const id = decodeURIComponent(sessionId);
  // The pinned Chief of staff thread is shown in one place, the Chief of staff itself: never a second, different copy.
  const chief = user.capabilities.has("work.use") ? globalCoordinatorArea(user) : null;
  if (chief && coordinatorPin(chief.id) === id) redirect("/chief");
  return <Conversation sessionId={id} initialRunId={run} />;
}
