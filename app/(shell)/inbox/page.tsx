import { requirePage } from "@/server/auth/page";
import { InboxPage } from "./InboxPage";

export const metadata = { title: "Inbox" };

/**
 * /inbox: its own view (was the Inbox tab of /areas). &capture=<text> opens the
 * capture sheet (the share target); &entry=<id> preselects an entry; &mode=focus
 * starts "Triage one at a time".
 */
export default async function Inbox({ searchParams }: { searchParams: Promise<{ capture?: string; entry?: string; mode?: string }> }) {
  await requirePage("work.use");
  const { capture, entry, mode } = await searchParams;
  return (
    <InboxPage
      initialCapture={typeof capture === "string" ? capture.slice(0, 2000) : undefined}
      initialEntry={typeof entry === "string" ? entry : undefined}
      initialFocus={mode === "focus"}
    />
  );
}
