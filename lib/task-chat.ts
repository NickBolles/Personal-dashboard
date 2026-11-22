/**
 * A task's chats (task threads, step 1). A task is one object with ONE primary chat: its session id is stored on
 * the task (`WorkItem.primarySessionId`) and every reader that needs "the" chat of a task reads it through
 * `primarySessionOf`. Its other chats (filed under it or linked to it) are kept under "Other chats" and can be
 * promoted. Pure and client-safe; the writes are in server/work/primary-chat.ts.
 */
import type { WorkItem, WorkKind, WorkLink } from "@/lib/work";

/**
 * Items that can have a primary chat. Areas are channels (their chat is the coordinator's), a conversation is a
 * chat itself, and a note holds no children, so it holds no chat.
 */
export const canHaveChat = (item: { kind: WorkKind; parentId: string | null }) =>
  item.parentId !== null && item.kind !== "area" && item.kind !== "conversation" && item.kind !== "note";

/** The task's primary chat session, or null while it has none. */
export const primarySessionOf = (item: Pick<WorkItem, "primarySessionId"> | null | undefined): string | null => item?.primarySessionId || null;

export type TaskChat = {
  sessionId: string;
  title: string;
  primary: boolean;
  /** filed: a conversation filed under the task; linked: a chat link on it; recorded: only the stored pointer names it */
  source: "filed" | "linked" | "recorded";
  /** when it was filed or linked (newest first under "Other chats") */
  at: string | null;
};

/**
 * The task's chats: the primary one, then every other chat filed under it or linked to it, newest first. A session
 * that is both filed and linked is listed once (as filed).
 */
export function taskChats(d: {
  item: Pick<WorkItem, "primarySessionId">;
  links: Pick<WorkLink, "kind" | "targetId" | "title" | "createdAt">[];
  children: Pick<WorkItem, "kind" | "sessionId" | "title" | "archived" | "createdAt">[];
}): { primary: TaskChat | null; others: TaskChat[] } {
  const primaryId = primarySessionOf(d.item);
  const bySession = new Map<string, TaskChat>();
  for (const c of d.children) {
    if (c.kind !== "conversation" || c.archived || !c.sessionId) continue;
    bySession.set(c.sessionId, { sessionId: c.sessionId, title: c.title, primary: c.sessionId === primaryId, source: "filed", at: c.createdAt });
  }
  for (const l of d.links) {
    if (l.kind !== "chat_session" || !l.targetId || bySession.has(l.targetId)) continue;
    bySession.set(l.targetId, { sessionId: l.targetId, title: l.title, primary: l.targetId === primaryId, source: "linked", at: l.createdAt });
  }
  const primary = primaryId ? (bySession.get(primaryId) ?? { sessionId: primaryId, title: "", primary: true, source: "recorded" as const, at: null }) : null;
  const others = [...bySession.values()].filter((c) => !c.primary).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return { primary, others };
}
