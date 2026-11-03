import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { ReadMarker } from "@/lib/conversation-unread";

/** "Mark all read" baseline row (never a real Hermes session id). */
export const READ_BASELINE = "*";
const T = schema.conversationReads;

/** This person's read markers + baseline. The first call sets the baseline to now, so existing chats start read. */
export function readMarkers(userId: string): { markers: Map<string, ReadMarker>; baseline: string } {
  const db = getDb();
  const rows = db.select().from(T).where(eq(T.userId, userId)).all();
  const markers = new Map<string, ReadMarker>();
  let baseline: string | null = null;
  for (const r of rows) {
    if (r.sessionId === READ_BASELINE) baseline = r.readAt;
    else markers.set(r.sessionId, { readAt: r.readAt, readCount: r.readCount });
  }
  if (!baseline) {
    baseline = new Date().toISOString();
    db.insert(T).values({ userId, sessionId: READ_BASELINE, readAt: baseline }).onConflictDoNothing().run();
  }
  return { markers, baseline };
}

/** Opening a conversation marks it read (message count / last message id when known). */
export function markRead(userId: string, sessionId: string, opts: { messageCount?: number | null; lastMessageId?: string | null } = {}) {
  const readAt = new Date().toISOString();
  const v = { readAt, readCount: opts.messageCount ?? null, lastMessageId: opts.lastMessageId ?? null };
  getDb()
    .insert(T)
    .values({ userId, sessionId, ...v })
    .onConflictDoUpdate({ target: [T.userId, T.sessionId], set: v })
    .run();
  return { readAt };
}

/** "Mark all read": move the baseline to now. Per-conversation markers stay (older ones lose to the baseline). */
export function markAllRead(userId: string) {
  const readAt = new Date().toISOString();
  getDb()
    .insert(T)
    .values({ userId, sessionId: READ_BASELINE, readAt })
    .onConflictDoUpdate({ target: [T.userId, T.sessionId], set: { readAt } })
    .run();
  return { readAt };
}

export function readMarker(userId: string, sessionId: string) {
  return getDb()
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), eq(T.sessionId, sessionId)))
    .get();
}
