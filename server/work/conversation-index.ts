import "server-only";
import { and, eq, gte, lt, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { isLocalSession } from "@/lib/assistant";
import type { SessionSummary } from "@/lib/hermes";

/**
 * Storage for the persisted conversation index (schema.conversationIndex):
 * each person's last Hermes conversation list, so the Areas views can render
 * at once while server/work/conversations.ts refreshes it in the background.
 * Only Hermes rows are kept (Claude-direct conversations are local and read
 * live). Readers must re-check access per row; this module never does.
 */
export type IndexEntry = {
  sessions: SessionSummary[];
  complete: boolean;
  refreshedAt: number | null;
  attemptedAt: number | null;
  lastError: string | null;
};

const T = schema.conversationIndex;
const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

/**
 * Per-person count of index changes made by Jarvis itself (patches, stale
 * marks). A refresh compares it before and after its upstream call and drops a
 * result that started before such a change. In-memory is enough: one server
 * process owns the index, and a restart drops in-flight refreshes too.
 */
const g = globalThis as unknown as { __jarvisIndexSeq?: Map<string, number> };
const seqs = (g.__jarvisIndexSeq ??= new Map());
export const indexMutationSeq = (userId: string) => seqs.get(userId) ?? 0;
const bump = (userId: string) => seqs.set(userId, indexMutationSeq(userId) + 1);

function parse(json: string): SessionSummary[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as SessionSummary[]) : [];
  } catch {
    return [];
  }
}

export function readIndex(userId: string): IndexEntry | null {
  const row = getDb().select().from(T).where(eq(T.userId, userId)).get();
  if (!row) return null;
  return {
    sessions: parse(row.sessions),
    complete: row.complete,
    refreshedAt: ms(row.refreshedAt),
    attemptedAt: ms(row.attemptedAt),
    lastError: row.lastError,
  };
}

/** Store a list Hermes just returned (Hermes rows only). */
export function writeIndex(userId: string, sessions: SessionSummary[], complete: boolean, now = new Date()) {
  const at = now.toISOString();
  const json = JSON.stringify(sessions.filter((s) => !isLocalSession(s.id)));
  getDb()
    .insert(T)
    .values({ userId, sessions: json, complete, refreshedAt: at, attemptedAt: at, lastError: null, accessedAt: at })
    .onConflictDoUpdate({ target: T.userId, set: { sessions: json, complete, refreshedAt: at, attemptedAt: at, lastError: null } })
    .run();
}

/** A refresh failed: keep the rows, remember when and why (no message text, just the error kind). */
export function noteIndexFailure(userId: string, error: string, now = new Date()) {
  const at = now.toISOString();
  const lastError = error.slice(0, 200);
  getDb()
    .insert(T)
    .values({ userId, attemptedAt: at, lastError, accessedAt: at })
    .onConflictDoUpdate({ target: T.userId, set: { attemptedAt: at, lastError } })
    .run();
}

/** The person opened a view that uses the index (throttled to one write a minute). */
export function touchIndex(userId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - 60_000).toISOString();
  const at = now.toISOString();
  getDb()
    .update(T)
    .set({ accessedAt: at })
    .where(and(eq(T.userId, userId), lt(T.accessedAt, cutoff)))
    .run();
}

/**
 * Apply a conversation Jarvis just changed or created (rename, archive,
 * share, new chat) so the cached list doesn't show the old state until the
 * next refresh. No-op when the person has no index yet.
 */
export function noteIndexedSession(userId: string, session: SessionSummary, opts: { insert?: boolean } = {}) {
  if (isLocalSession(session.id)) return;
  const row = getDb().select({ sessions: T.sessions }).from(T).where(eq(T.userId, userId)).get();
  if (!row) return;
  const list = parse(row.sessions);
  const i = list.findIndex((s) => s.id === session.id);
  if (i >= 0) list[i] = { ...list[i], ...session };
  else if (opts.insert !== false) list.unshift(session);
  else return;
  bump(userId);
  getDb()
    .update(T)
    .set({ sessions: JSON.stringify(list) })
    .where(eq(T.userId, userId))
    .run();
}

/**
 * The conversation's node in the Areas tree takes Hermes' current title (as
 * syncConversationTitles does from a list): with lists served from the index,
 * a chat that just got its title would otherwise keep "Untitled conversation"
 * until the next refresh.
 */
export function syncIndexedTitle(userId: string, session: Pick<SessionSummary, "id" | "title">) {
  const title = session.title?.trim().slice(0, 200);
  if (!title) return;
  const W = schema.workItems;
  getDb()
    .update(W)
    .set({ title })
    .where(and(eq(W.userId, userId), eq(W.kind, "conversation"), eq(W.sessionId, session.id), ne(W.title, title)))
    .run();
}

/** Something changed upstream that the cached list can't know (a run started): revalidate on the next read. */
export function markIndexStale(userId: string) {
  bump(userId);
  getDb().update(T).set({ complete: false }).where(eq(T.userId, userId)).run();
}

/** People whose index was used since `since` (the warmer keeps only theirs fresh). */
export function recentIndexUsers(since: Date) {
  return getDb()
    .select({ userId: T.userId, refreshedAt: T.refreshedAt, attemptedAt: T.attemptedAt })
    .from(T)
    .where(gte(T.accessedAt, since.toISOString()))
    .all()
    .map((r) => ({ userId: r.userId, refreshedAt: ms(r.refreshedAt), attemptedAt: ms(r.attemptedAt) }));
}
