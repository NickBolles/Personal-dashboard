"use client";

import { ChatThread } from "./ChatThread";

// The thread itself lives in ./ChatThread (the task page embeds the same one); these names are still imported from here.
export { groupTimeline } from "./Timeline";
export { shareSummary, toolsByReply } from "./ChatThread";

/** The chat page: one conversation as the page. */
export function Conversation({ sessionId, initialRunId }: { sessionId: string; initialRunId?: string }) {
  return <ChatThread sessionId={sessionId} initialRunId={initialRunId} frame="page" />;
}
