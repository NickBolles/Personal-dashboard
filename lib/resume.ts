/**
 * Resume hub ("In flight") contract — board jarvis-coordinator-parity-20261107, option 3A.
 *
 * GET /api/work/resume  -> ResumeResponse   (cap work.use; conversations need hermes.chat too)
 *
 * One list of what the owner can pick up: agent runs in flight (running / waiting / stalled /
 * failed in the last 24 h), recent conversations by last activity with their Areas path, and
 * the Unfiled bucket. Every row has exactly one primary "Resume" target (`href`).
 * Reads only Jarvis's own data (conversation index, work items, agent runs): never Hermes live.
 */
import type { RunLive } from "@/lib/agent-runs";

export type ResumeRunRow = {
  kind: "run";
  /** stable row key */
  key: string;
  itemId: string;
  title: string;
  /** "Area › Project › Item" */
  path: string;
  live: RunLive;
  approval: boolean;
  stalled: boolean;
  /** who is on it (agent profile / coordinator / person name) */
  who: string | null;
  at: string | null;
  /** the conversation to resume when known, else the item */
  href: string;
  itemHref: string;
  sessionId: string | null;
};

export type ResumeConversationRow = {
  kind: "conversation";
  key: string;
  sessionId: string;
  title: string;
  preview: string | null;
  /** "Area › Project"; null = Unfiled */
  path: string | null;
  /** the item it sits under (for breadcrumbs / Focus) */
  parentId: string | null;
  unfiled: boolean;
  unread: boolean;
  unreadCount: number | null;
  agentProfile: string | null;
  at: string | null;
  href: string;
  itemHref: string | null;
};

export type ResumeRow = ResumeRunRow | ResumeConversationRow;

export type ResumeResponse = {
  /** runs in flight first (waiting before running), then failed in the last 24 h */
  runs: ResumeRunRow[];
  /** most recent first, max RESUME_LIMITS.conversations */
  conversations: ResumeConversationRow[];
  counts: { running: number; waiting: number; unread: number; unfiled: number };
  /** conversation list unavailable (no hermes.chat, or the index is down) — never shown as "0" */
  conversationsUnavailable: boolean;
  updating?: boolean;
  fetchedAt: string;
};

export const RESUME_LIMITS = { conversations: 40, runs: 30, today: 3 } as const;

/** Today strip: the top N rows across both lists (in-flight runs first, then unread, then recent). */
export function pickUpRows(r: Pick<ResumeResponse, "runs" | "conversations">, n: number = RESUME_LIMITS.today): ResumeRow[] {
  const runs = r.runs.filter((x) => x.live === "running" || x.live === "waiting");
  const unread = r.conversations.filter((c) => c.unread);
  const rest = r.conversations.filter((c) => !c.unread);
  const seen = new Set<string>();
  const out: ResumeRow[] = [];
  for (const row of [...runs, ...unread, ...rest]) {
    const sid = row.sessionId;
    if (sid && seen.has(sid)) continue;
    if (sid) seen.add(sid);
    out.push(row);
    if (out.length >= n) break;
  }
  return out;
}
