import { requirePage } from "@/server/auth/page";
import { Conversation } from "@/components/chat/Conversation";

export const metadata = { title: "Conversation" };

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ sessionId: string }>; searchParams: Promise<{ run?: string }> }) {
  await requirePage("hermes.chat");
  const { sessionId } = await params;
  const { run } = await searchParams;
  return <Conversation sessionId={decodeURIComponent(sessionId)} initialRunId={run} />;
}
