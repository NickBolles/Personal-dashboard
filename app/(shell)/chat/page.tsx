import { ChatIndex } from "./ChatIndex";

export const metadata = { title: "Hermes" };

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ new?: string; context?: string; draft?: string }> }) {
  const sp = await searchParams;
  return <ChatIndex startNew={sp.new === "1"} context={sp.context} draft={sp.draft} />;
}
