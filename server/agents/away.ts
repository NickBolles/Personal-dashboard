import "server-only";
import { and, desc, eq, gt, ne, or } from "drizzle-orm";
import type { CurrentUser } from "@/server/auth";
import { getDb, schema } from "@/server/db";
import { can } from "@/server/access";
import { getSetting, setSetting } from "@/server/settings";
import { listItems } from "@/server/work/store";
import { localMinutes } from "@/lib/time";
import { choreCount, effectiveAutonomy, WAITING_SUMMARY, type AwayDigest, type AwayRun } from "@/lib/away";
import { J, R, assertAwayOwner, jobRow, scheduleTimezone, type RunRow } from "./schedules";
import { audit } from "@/server/audit";
const dismissKey = (id: string) => `away_digest_dismissed_at:${id}`;
export function awayRun(user: CurrentUser, row: RunRow): AwayRun {
  const job = jobRow(user, row.jobId, true);
  const items = listItems(user.id);
  const area = items.find((i) => i.id === job.areaId);
  const decisions = JSON.parse(row.decisionsJson) as AwayRun["decisions"];
  return {
    id: row.id,
    jobId: job.id,
    jobTitle: job.title,
    areaId: area?.id ?? null,
    areaTitle: area?.title ?? null,
    slot: row.slot,
    manual: row.slot.startsWith("manual:"),
    status: row.status as AwayRun["status"],
    silent: row.silent,
    waiting: row.status === "running" && row.summary === WAITING_SUMMARY,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    summary: row.summary,
    error: row.error,
    sessionId: row.sessionId,
    agentRunId: row.agentRunId,
    profile: row.profile,
    changes: JSON.parse(row.changesJson),
    refused: JSON.parse(row.refusedJson),
    decisions: decisions.map((d) => ({ ...d, open: items.some((i) => i.id === d.itemId && !i.archived && i.decision?.question === d.question) })),
  };
}
export function awayDigest(user: CurrentUser, now = new Date()): AwayDigest {
  assertAwayOwner(user);
  const since = getSetting<string>(dismissKey(user.id)) ?? new Date(now.getTime() - 86_400_000).toISOString();
  const eligible = new Set(
    listItems(user.id)
      .filter((i) => i.kind === "area" && !i.archived && effectiveAutonomy(i) !== "off")
      .map((i) => i.id),
  );
  const rows = getDb()
    .select({ run: R, areaId: J.areaId })
    .from(R)
    .innerJoin(J, eq(J.id, R.jobId))
    // A run counts as new when it FINISHED after the dismissal (#230): runs already running when the
    // owner dismissed still surface their results. Active runs always show.
    .where(and(eq(R.userId, user.id), ne(R.status, "skipped"), or(eq(R.status, "running"), gt(R.finishedAt, since), gt(R.startedAt, since))))
    .orderBy(desc(R.startedAt))
    .all()
    .filter((r) => r.areaId && eligible.has(r.areaId))
    .slice(0, 20);
  const runs = rows.map((r) => awayRun(user, r.run));
  const counts = {
    ran: runs.filter((r) => r.status === "done" || r.status === "failed").length,
    failed: runs.filter((r) => r.status === "failed").length,
    changes: runs.reduce((n, r) => n + r.changes.length, 0),
    needsYou: runs.reduce((n, r) => n + r.decisions.filter((d) => d.open).length, 0) + runs.filter((r) => r.waiting).length,
    running: runs.filter((r) => r.status === "running" && !r.waiting).length,
    waiting: runs.filter((r) => r.waiting).length,
  };
  const prefix = localMinutes(now, scheduleTimezone()) < 660 ? "Overnight" : "While you were away";
  const parts = [`${counts.ran} ran`, ...(counts.needsYou ? [`${counts.needsYou} needs you`] : []), ...(counts.running ? [`${counts.running} running`] : [])];
  const C = schema.sourceCompletions;
  const chores = can(user, "skylight.view")
    ? getDb()
        .select()
        .from(C)
        .where(and(eq(C.source, "skylight"), or(eq(C.outcome, "completed"), eq(C.outcome, "skipped")), gt(C.completedAt, since)))
        .orderBy(desc(C.completedAt))
        .limit(50)
        .all()
        .map((c) => ({ id: c.id, title: c.title, status: c.outcome === "skipped" ? ("skipped" as const) : ("completed" as const), at: c.completedAt }))
    : [];
  const completed = chores.filter((c) => c.status === "completed").length;
  const skipped = chores.filter((c) => c.status === "skipped").length;
  const choreParts = [...(completed ? [choreCount(completed, "completed")] : []), ...(skipped ? [choreCount(skipped, "skipped")] : [])];
  return {
    runs,
    since,
    counts,
    chores,
    line: runs.length || chores.length ? `${prefix}: ${[...(runs.length ? parts : []), ...choreParts].join(" · ")}` : null,
  };
}
export function dismissAway(user: CurrentUser, now = new Date(), correlationId = "away-dismiss") {
  assertAwayOwner(user);
  setSetting(dismissKey(user.id), now.toISOString());
  audit({ actor: user.id, action: "agents.away.dismiss", source: "agents", result: "ok", correlationId });
  return { ok: true };
}
