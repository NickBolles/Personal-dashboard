import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
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
  const done = data.actions.filter((a) => a.status === "completed" || a.status === "skipped");
  // Open readback may be Undo/reopen: retain history, but do not recap it as still completed/skipped.
  const open = data.actions.filter((a) => a.status === "open" && a.skylight?.kind === "chore");
  if (!done.length && !open.length) return data;
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
    for (const a of open) {
      tx.update(T)
        .set({ outcome: "reopened", completedAt: at })
        .where(and(eq(T.source, a.source), eq(T.sourceId, a.sourceId), ne(T.outcome, "reopened"), ne(T.outcome, "superseded")))
        .run();
    }
    for (const a of done) {
      // #P0: the window spans ±7 days, so a completion keeps its own (frame-local) day; one first seen
      // after its day is stamped at noon UTC of that day rather than "now" (no fake "done just now").
      const day = (a.skylight?.kind === "chore" && (a.status === "skipped" ? a.skylight.skippedOn : a.skylight.completedOn)) || today;
      const stamp = day === today ? at : day < today ? `${day}T12:00:00.000Z` : at;
      // The terminal date can change without changing the occurrence identity.
      if (a.skylight?.kind === "chore")
        tx.update(T)
          .set({ outcome: "superseded" })
          .where(and(eq(T.source, a.source), eq(T.sourceId, a.sourceId), ne(T.day, day), ne(T.outcome, a.status)))
          .run();
      tx.insert(T)
        .values({
          id: newId("sc"),
          source: a.source,
          sourceId: a.sourceId,
          day,
          title: a.title,
          outcome: a.status,
          wasOpen: prevOpen.has(a.id),
          completedAt: stamp,
        })
        .onConflictDoUpdate({
          target: [T.source, T.sourceId, T.day],
          set: { outcome: a.status, title: a.title, completedAt: sql`CASE WHEN ${T.outcome} = ${a.status} THEN ${T.completedAt} ELSE ${stamp} END` },
        })
        .run();
      const row = tx
        .select({ completedAt: T.completedAt })
        .from(T)
        .where(and(eq(T.source, a.source), eq(T.sourceId, a.sourceId), eq(T.day, day)))
        .get();
      if (row) seen.set(a.id, row.completedAt);
    }
  });
  const actions: NextAction[] = data.actions.map((a) => (seen.has(a.id) ? { ...a, updatedAt: seen.get(a.id)! } : a));
  return { ...data, actions };
}
