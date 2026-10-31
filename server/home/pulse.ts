import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can, type Capable } from "@/server/access";
import { isClosed } from "@/lib/work";
import { addedVsCompleted, type HomePulse } from "@/lib/pulse";

const TZ = process.env.TZ || "America/Chicago";

/**
 * Today counts for Home: approvals waiting (Jarvis-tracked Hermes runs paused on
 * an approval), work awaiting validation, merged-but-not-settled work (GitHub
 * PR links the read-only App marked merged) and a 14-day added-vs-completed
 * trend from work item timestamps. Read-only: never settles anything.
 */
export function homePulse(user: Capable & { id: string }, now = new Date()): HomePulse {
  const db = getDb();
  const approvals = can(user, "hermes.chat")
    ? db
        .select({ runId: schema.runs.runId })
        .from(schema.runs)
        .where(and(eq(schema.runs.userId, user.id), eq(schema.runs.status, "waiting_for_approval")))
        .all().length
    : null;
  if (!can(user, "work.use")) return { approvals, awaitingValidation: null, mergedNotSettled: null, trend: null };
  const T = schema.workItems;
  const rows = db
    .select({ id: T.id, kind: T.kind, status: T.status, archived: T.archived, createdAt: T.createdAt, completedAt: T.completedAt })
    .from(T)
    .where(eq(T.userId, user.id))
    .all()
    .filter((r) => r.kind !== "area" && r.kind !== "conversation");
  const open = rows.filter((r) => !r.archived && !isClosed(r.status));
  const ids = open.map((r) => r.id);
  const merged = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const l of db
      .select({ itemId: schema.workLinks.itemId })
      .from(schema.workLinks)
      .where(
        and(
          inArray(schema.workLinks.itemId, ids.slice(i, i + 500)),
          eq(schema.workLinks.kind, "github_pr"),
          eq(schema.workLinks.role, "implementation"),
          eq(schema.workLinks.externalState, "merged"),
        ),
      )
      .all())
      merged.add(l.itemId);
  }
  return {
    approvals,
    awaitingValidation: open.filter((r) => r.status === "awaiting_validation").length,
    mergedNotSettled: merged.size,
    // Only settled work counts as completed: abandoned/superseded also stamp
    // completedAt (lifecycle planTransition) but stay in the added series only.
    trend: addedVsCompleted(
      rows.map((r) => ({ createdAt: r.createdAt, completedAt: r.status === "settled" ? r.completedAt : null })),
      now,
      TZ,
    ),
  };
}
