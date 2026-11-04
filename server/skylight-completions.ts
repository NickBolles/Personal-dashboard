import "server-only";
import { and, eq } from "drizzle-orm";
import type { NextAction } from "@/lib/contracts";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import type { SourceData } from "@/integrations/types";

/**
 * Persist the completed chores of a fresh Skylight read and stamp each card with the time Jarvis
 * first saw it completed (Skylight only gives the date). The snapshot is replaced on every sync,
 * so without this a completion would have no time and no history (Activity, Home trend).
 * `prevPayload` is the last snapshot: an action that was open there is an open → done transition.
 */
export function recordCompletions(data: SourceData, prevPayload: string | null | undefined, today: string, now = new Date()): SourceData {
  const done = data.actions.filter((a) => a.status === "completed");
  if (!done.length) return data;
  let prevOpen = new Set<string>();
  try {
    const prev = prevPayload ? (JSON.parse(prevPayload) as SourceData) : undefined;
    prevOpen = new Set((prev?.actions ?? []).filter((a) => a.status === "open").map((a) => a.id));
  } catch {
    /* unreadable snapshot: treat as first sight */
  }
  const db = getDb();
  const T = schema.sourceCompletions;
  const at = now.toISOString();
  const seen = new Map<string, string>();
  db.transaction((tx) => {
    for (const a of done) {
      tx.insert(T)
        .values({ id: newId("sc"), source: a.source, sourceId: a.sourceId, day: today, title: a.title, wasOpen: prevOpen.has(a.id), completedAt: at })
        .onConflictDoNothing()
        .run();
      const row = tx
        .select({ completedAt: T.completedAt })
        .from(T)
        .where(and(eq(T.source, a.source), eq(T.sourceId, a.sourceId), eq(T.day, today)))
        .get();
      if (row) seen.set(a.id, row.completedAt);
    }
  });
  const actions: NextAction[] = data.actions.map((a) => (seen.has(a.id) ? { ...a, updatedAt: seen.get(a.id)! } : a));
  return { ...data, actions };
}
