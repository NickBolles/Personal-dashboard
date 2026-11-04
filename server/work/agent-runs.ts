import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import {
  aggregateRunState,
  AGENT_RUN_STATES,
  deployOf,
  liveOfAgentRun,
  parseRunChildren,
  type ExternalRun,
  isActive,
  liveOfJob,
  liveOfRun,
  whoIsOn,
  type AgentRunsResponse,
  type ItemAgentInfo,
  type RunSample,
} from "@/lib/agent-runs";
import { areaIndex, bucketOf } from "@/lib/map-rollup";
import { isContainer, type WorkItem } from "@/lib/work";
import { listItems } from "./store";
import { linksByItem } from "./decisions";

const chunks = <T>(xs: T[], n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Each item's Hermes conversations: conversation children + chat_session links. */
function sessionsByItem(items: WorkItem[], links: Map<string, { kind: string; targetId: string | null }[]>) {
  const out = new Map<string, Set<string>>();
  const add = (id: string, s: string) => out.set(id, (out.get(id) ?? new Set()).add(s));
  for (const c of items) if (c.kind === "conversation" && c.sessionId && c.parentId && !c.archived) add(c.parentId, c.sessionId);
  for (const [id, ls] of links) for (const l of ls) if (l.kind === "chat_session" && l.targetId) add(id, l.targetId);
  return out;
}

/**
 * Read-only aggregation of agent work per item: who is on it (assignee or the
 * area coordinator), the live state of its linked Hermes runs and AI jobs, its
 * PRs (CI, merge, deploy) and the latest AI report. Nothing here writes or
 * starts anything.
 */
export function agentRuns(user: CurrentUser, items: WorkItem[] = listItems(user.id)): AgentRunsResponse {
  const db = getDb();
  const live = items.filter((i) => !i.archived);
  const byId = new Map(live.map((i) => [i.id, i]));
  const areaOf = areaIndex(live);
  const work = live.filter((i) => i.kind !== "conversation" && i.parentId !== null);
  const ids = work.map((i) => i.id);
  const links = linksByItem(ids);
  const sessions = sessionsByItem(live, links);

  // Hermes runs Jarvis started, by session.
  const runsBySession = new Map<string, RunSample[]>();
  const allSessions = [...new Set([...sessions.values()].flatMap((s) => [...s]))];
  if (can(user, "hermes.chat"))
    for (const part of chunks(allSessions))
      for (const r of db
        .select({ sessionId: schema.runs.sessionId, status: schema.runs.status, startedAt: schema.runs.startedAt, completedAt: schema.runs.completedAt })
        .from(schema.runs)
        .where(and(eq(schema.runs.userId, user.id), inArray(schema.runs.sessionId, part)))
        .all())
        runsBySession.set(r.sessionId, [
          ...(runsBySession.get(r.sessionId) ?? []),
          {
            live: liveOfRun(r.status),
            at: r.completedAt ?? r.startedAt,
            sessionId: r.sessionId,
            source: "chat",
            approval: r.status === "waiting_for_approval",
          },
        ]);

  // AI jobs and reports on the items.
  const jobs = new Map<string, RunSample[]>();
  const reports = new Map<string, ItemAgentInfo["report"]>();
  for (const part of chunks(ids)) {
    for (const j of db
      .select({
        subjectId: schema.aiJobs.subjectId,
        state: schema.aiJobs.state,
        createdAt: schema.aiJobs.createdAt,
        finishedAt: schema.aiJobs.finishedAt,
        startedAt: schema.aiJobs.startedAt,
        sessionId: schema.aiJobs.hermesSessionId,
        visible: schema.aiJobs.visibleSession,
      })
      .from(schema.aiJobs)
      .where(and(eq(schema.aiJobs.userId, user.id), eq(schema.aiJobs.subjectType, "work_item"), inArray(schema.aiJobs.subjectId, part)))
      .all())
      jobs.set(j.subjectId, [
        ...(jobs.get(j.subjectId) ?? []),
        {
          live: liveOfJob(j.state),
          at: j.finishedAt ?? j.startedAt ?? j.createdAt,
          sessionId: j.visible ? j.sessionId : null,
          source: "job",
          approval: j.state === "waiting_approval",
        },
      ]);
    for (const r of db
      .select({
        id: schema.aiReports.id,
        subjectId: schema.aiReports.subjectId,
        title: schema.aiReports.title,
        summary: schema.aiReports.summary,
        createdAt: schema.aiReports.createdAt,
      })
      .from(schema.aiReports)
      .where(and(eq(schema.aiReports.userId, user.id), eq(schema.aiReports.subjectType, "work_item"), inArray(schema.aiReports.subjectId, part)))
      .orderBy(desc(schema.aiReports.createdAt))
      .all())
      if (!reports.has(r.subjectId))
        reports.set(r.subjectId, { title: r.title, summary: r.summary.slice(0, 400), at: r.createdAt, href: `/areas?item=${encodeURIComponent(r.subjectId)}` });
  }

  // Runs agents registered through Jarvis MCP (agent_runs; docs/agent-tools.md).
  const external = new Map<string, ExternalRun[]>();
  for (const part of chunks(ids))
    for (const r of db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.userId, user.id), inArray(schema.agentRuns.itemId, part)))
      .orderBy(desc(schema.agentRuns.updatedAt))
      .all()) {
      const list = external.get(r.itemId) ?? [];
      list.push({
        id: r.id,
        title: r.title,
        profile: r.profile,
        state: (AGENT_RUN_STATES as readonly string[]).includes(r.state) ? (r.state as ExternalRun["state"]) : "running",
        summary: r.summary,
        prUrl: r.prUrl,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        hermesSessionId: r.hermesSessionId,
        delegationId: r.delegationId,
        transcriptPath: r.transcriptPath,
        children: parseRunChildren(r.childrenJson),
      });
      external.set(r.itemId, list);
    }

  const prRows = new Map<string, { targetId: string | null; url: string | null; title: string; state: string | null; checks: string | null }[]>();
  for (const part of chunks(ids))
    for (const l of db
      .select({
        itemId: schema.workLinks.itemId,
        targetId: schema.workLinks.targetId,
        url: schema.workLinks.url,
        title: schema.workLinks.title,
        state: schema.workLinks.externalState,
        checks: schema.workLinks.checksState,
      })
      .from(schema.workLinks)
      .where(and(inArray(schema.workLinks.itemId, part), eq(schema.workLinks.kind, "github_pr")))
      .all())
      prRows.set(l.itemId, [...(prRows.get(l.itemId) ?? []), l]);

  const kidsOf = new Map<string, WorkItem[]>();
  for (const c of live) if (c.parentId && !isContainer(c) && c.kind !== "conversation") kidsOf.set(c.parentId, [...(kidsOf.get(c.parentId) ?? []), c]);
  const out: Record<string, ItemAgentInfo> = {};
  for (const i of work) {
    const areaId = areaOf.get(i.id) ?? null;
    const area = areaId ? byId.get(areaId) : undefined;
    const ext = external.get(i.id) ?? [];
    const samples = [
      ...[...(sessions.get(i.id) ?? [])].flatMap((s) => runsBySession.get(s) ?? []),
      ...(jobs.get(i.id) ?? []),
      ...ext.map((r): RunSample => ({ live: liveOfAgentRun(r.state), at: r.updatedAt, sessionId: null, source: "agent" })),
    ];
    const prs = (prRows.get(i.id) ?? []).map((p) => ({
      ref: p.targetId ?? p.url ?? "PR",
      url: p.url,
      title: p.title,
      state: p.state,
      checks: p.checks,
      deploy: deployOf(p.state, i),
    }));
    const who = whoIsOn(i, area?.settings?.agentMode ?? null);
    const report = reports.get(i.id) ?? null;
    if (!who && !samples.length && !prs.length && !report) continue;
    const agg = aggregateRunState(samples);
    const kids = kidsOf.get(i.id) ?? [];
    out[i.id] = {
      itemId: i.id,
      areaId,
      title: i.title,
      who,
      live: agg.live,
      ...(agg.approval ? { approval: true } : {}),
      liveAt: agg.at,
      sessionId: agg.sessionId ?? ([...(sessions.get(i.id) ?? [])][0] || null),
      runs: samples.length,
      prs,
      report,
      progress: kids.length ? { done: kids.filter((c) => bucketOf(c) === "done").length, total: kids.length } : null,
      // Running runs first (newest first within each group) so a stalled one is never cut by the cap.
      ...(ext.length ? { agentRuns: [...ext.filter((r) => r.state === "running"), ...ext.filter((r) => r.state !== "running")].slice(0, 5) } : {}),
    };
  }
  const active = Object.values(out)
    .filter(isActive)
    .sort((a, b) => (a.live === b.live ? ((b.liveAt ?? "") > (a.liveAt ?? "") ? 1 : -1) : a.live === "waiting" ? -1 : 1));
  return { items: out, active };
}
