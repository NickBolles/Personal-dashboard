import "server-only";
import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can, type Capable } from "@/server/access";
import { isClosed } from "@/lib/work";
import { addedVsCompleted, type HomePulse } from "@/lib/pulse";
import { getPreferences } from "@/server/settings";

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
  const everything = db
    .select({ id: T.id, parentId: T.parentId, kind: T.kind, status: T.status, archived: T.archived, createdAt: T.createdAt, completedAt: T.completedAt })
    .from(T)
    .where(eq(T.userId, user.id))
    .all();
  // #82: an archived area/project hides its whole branch (descendants keep archived=false), as on Today
  const byId = new Map(everything.map((r) => [r.id, r]));
  const hiddenMemo = new Map<string, boolean>();
  const hidden = (id: string): boolean => {
    const seen: string[] = [];
    let res = false;
    for (let c = byId.get(id); c; c = c.parentId ? byId.get(c.parentId) : undefined) {
      const known = hiddenMemo.get(c.id);
      if (known !== undefined) {
        res = known;
        break;
      }
      if (c.archived || seen.length > 64) {
        res = true;
        break;
      }
      seen.push(c.id);
    }
    for (const s of seen) hiddenMemo.set(s, res);
    return res;
  };
  const rows = everything.filter((r) => r.kind !== "area" && r.kind !== "conversation");
  const open = rows.filter((r) => !hidden(r.id) && !isClosed(r.status));
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
      [
        ...rows.map((r) => ({ createdAt: r.createdAt, completedAt: r.status === "settled" ? r.completedAt : null })),
        // Skylight chores done (first seen completed by a sync) count as completed, never as added.
        ...(can(user, "skylight.view")
          ? db
              .select({ completedAt: schema.sourceCompletions.completedAt })
              .from(schema.sourceCompletions)
              .where(
                and(
                  eq(schema.sourceCompletions.source, "skylight"),
                  gte(schema.sourceCompletions.completedAt, new Date(now.getTime() - 15 * 86_400_000).toISOString()),
                ),
              )
              .all()
              .map((r) => ({ createdAt: null, completedAt: r.completedAt }))
          : []),
      ],
      now,
      // #83: the household time zone from Settings (same day boundaries as the rest of Home)
      getPreferences().timezone || TZ,
    ),
  };
}
