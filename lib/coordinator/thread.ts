/**
 * The Chief of staff (coordinator) thread of an area: which conversation the rail/tray talks in.
 *
 * Since PR A (release 74) the thread is PINNED: the owner's choice is stored per area (settings key
 * `coordinator_thread:<areaId>`), set by the first send from the panel, "Use this thread" on an earlier thread, or
 * "New thread". Without a pin (or when the pinned conversation was archived or moved) the newest conversation filed
 * directly under the area is used, but ops/smoke chats never are: before this, every post-deploy smoke chat filed
 * under Portfolio silently became the owner's thread.
 *
 * Pure and client-safe (used by the server selection, the panel's earlier-threads list and unit tests).
 */

/** Conversations created by our ops tooling (chat-send smoke: "zz-smoke HH:MM <id>"). Never a coordinator thread. */
const OPS_TITLE = /^\s*zz-smoke\b/i;

export function isOpsConversation(c: { title?: string | null }): boolean {
  return OPS_TITLE.test(c.title ?? "");
}

export type ThreadCandidate = {
  id: string;
  parentId: string | null;
  kind: string;
  sessionId?: string | null;
  archived: boolean;
  title: string;
  updatedAt: string;
};

export const coordinatorThreadKey = (areaId: string) => `coordinator_thread:${areaId}`;

/** What the settings row holds. `sessionId` null = no pin (back to the newest-conversation rule). */
export type CoordinatorPin = { sessionId: string | null; at: string };

export function readPin(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const s = (raw as { sessionId?: unknown }).sessionId;
  return typeof s === "string" && s ? s : null;
}

/** The area's live conversations (filed directly under it, with a session, not archived), newest first. */
export function areaThreads<T extends ThreadCandidate>(items: T[], areaId: string): T[] {
  return items
    .filter((c) => c.parentId === areaId && c.kind === "conversation" && !!c.sessionId && !c.archived)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/**
 * The coordinator thread: the pinned conversation while it is still live under the area, otherwise the newest
 * live conversation that is not an ops/smoke chat. `pinned` says which rule answered.
 */
export function pickCoordinatorThread<T extends ThreadCandidate>(
  items: T[],
  areaId: string,
  pinnedSessionId: string | null,
): { item: T | null; pinned: boolean } {
  const threads = areaThreads(items, areaId);
  if (pinnedSessionId) {
    const hit = threads.find((c) => c.sessionId === pinnedSessionId);
    if (hit) return { item: hit, pinned: true };
  }
  return { item: threads.find((c) => !isOpsConversation(c)) ?? null, pinned: false };
}

/** How many message groups the panel shows first, and how many more each "Load earlier" adds. */
export const THREAD_FIRST_PAGE = 12;
export const THREAD_PAGE = 20;

/**
 * How many of `total` groups to show: at least `shown`, and never fewer than reach back to `mustInclude` (the first
 * group after the "Since …" divider), so the divider is never paged away.
 */
export function visibleGroupCount(total: number, shown: number, mustInclude = -1): number {
  const need = mustInclude >= 0 ? total - mustInclude + 1 : 0;
  return Math.min(total, Math.max(shown, need));
}
