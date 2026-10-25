import { requirePage } from "@/server/auth/page";
import { ChatIndex } from "./ChatIndex";

export const metadata = { title: "Conversations" };

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ new?: string; context?: string; draft?: string; view?: string }> }) {
  await requirePage("hermes.chat");
  const sp = await searchParams;
  return <ChatIndex startNew={sp.new === "1"} context={sp.context} draft={sp.draft} view={sp.view} />;
}
