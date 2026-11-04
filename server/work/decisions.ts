import "server-only";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { STALL_AFTER_MIN } from "@/lib/agent-runs";
import { sortDecisions, type DecisionEntry, type DecisionsResponse } from "@/lib/decisions";
import type { WorkItem } from "@/lib/work";
import { areaIndex, type MapExport, type MapExportNode, areaRollups, bucketOf } from "@/lib/map-rollup";
import { listItems } from "./store";
import { coordinatorSessions } from "./coordinator";

function approvalText(raw: string | null): string {
  if (!raw) return "A running task is waiting for your approval.";
  try {
    const v = JSON.parse(raw) as { description?: string; command?: string };
    return v.description || v.command || "A running task is waiting for your approval.";
  } catch {
    return raw.slice(0, 300);
  }
}

/** The item's linked Hermes conversation: a conversation child, else a chat_session link. */
function sessionFor(item: WorkItem, items: WorkItem[], links: Map<string, { kind: string; targetId: string | null }[]>): string | null {
  const child = items.find((c) => c.parentId === item.id && c.kind === "conversation" && c.sessionId && !c.archived);
  if (child?.sessionId) return child.sessionId;
  return links.get(item.id)?.find((l) => l.kind === "chat_session" && l.targetId)?.targetId ?? null;
}

/**
 * "Needs you": owner decisions on work items, Hermes runs paused on an
 * approval, and workflow runs with AI proposals or a proposed summary waiting
 * for a tap. Read-only; answering goes through each source's own route.
 */
export function listDecisions(user: CurrentUser, items: WorkItem[] = can(user, "work.use") ? listItems(user.id) : []): DecisionsResponse {
  const db = getDb();
  const entries: DecisionEntry[] = [];
  const open = items.filter((i) => i.decision && !i.archived);
  if (open.length) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const areaOf = areaIndex(items);
    const links = linksByItem(open.map((i) => i.id));
    const coord = coordinatorSessions(items);
    for (const i of open)
      entries.push({
        key: `item:${i.id}`,
        kind: "item",
        title: i.title,
        question: i.decision!.question,
        choices: i.decision!.choices,
        href: `/areas?item=${encodeURIComponent(i.id)}`,
        at: i.decision!.askedAt || i.updatedAt,
        itemId: i.id,
        areaTitle: byId.get(areaOf.get(i.id) ?? "")?.title,
        sessionId: sessionFor(i, items, links),
        coordinatorSessionId: coord.get(areaOf.get(i.id) ?? "") ?? null,
      });
  }
  if (can(user, "hermes.chat")) {
    const runs = db
      .select({ runId: schema.runs.runId, sessionId: schema.runs.sessionId, pending: schema.runs.pendingApproval, startedAt: schema.runs.startedAt })
      .from(schema.runs)
      .where(and(eq(schema.runs.userId, user.id), eq(schema.runs.status, "waiting_for_approval")))
      .all();
    for (const r of runs)
      entries.push({
        key: `approval:${r.runId}`,
        kind: "approval",
        title: "Hermes needs your approval",
        question: approvalText(r.pending),
        choices: [],
        href: `/chat/${encodeURIComponent(r.sessionId)}`,
        at: r.startedAt,
      });
  }
  if (can(user, "work.use")) {
    const wf = db
      .select({
        id: schema.workflowRuns.id,
        title: schema.workflowRuns.title,
        conversationId: schema.workflowRuns.conversationId,
        proposals: schema.workflowRuns.proposalsJson,
        summaryState: schema.workflowRuns.summaryState,
        updatedAt: schema.workflowRuns.updatedAt,
      })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.ownerId, user.id))
      .all();
    for (const w of wf) {
      let n = 0;
      try {
        const p = JSON.parse(w.proposals) as unknown;
        n = Array.isArray(p) ? p.length : 0;
      } catch {
        n = 0;
      }
      if (!n && w.summaryState !== "proposed") continue;
      entries.push({
        key: `workflow:${w.id}`,
        kind: "workflow",
        title: w.title,
        question: n ? `${n} proposed ${n === 1 ? "value" : "values"} to accept or dismiss` : "Proposed summary to accept",
        choices: [],
        href: w.conversationId ? `/chat/${encodeURIComponent(w.conversationId)}` : "/workflows",
        at: w.updatedAt,
      });
    }
  }
  if (can(user, "work.use")) {
    // Agent runs (MCP) still "running" with no update for STALL_AFTER_MIN: a nudge only, nothing changes.
    const live = new Map(items.filter((i) => !i.archived).map((i) => [i.id, i]));
    const cutoff = new Date(Date.now() - STALL_AFTER_MIN * 60_000).toISOString();
    const stale = db
      .select({
        id: schema.agentRuns.id,
        itemId: schema.agentRuns.itemId,
        title: schema.agentRuns.title,
        profile: schema.agentRuns.profile,
        updatedAt: schema.agentRuns.updatedAt,
      })
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.userId, user.id), eq(schema.agentRuns.state, "running"), lt(schema.agentRuns.updatedAt, cutoff)))
      .orderBy(desc(schema.agentRuns.updatedAt))
      .limit(50)
      .all();
    const areaOf = stale.length ? areaIndex(items) : null;
    for (const r of stale) {
      const item = live.get(r.itemId);
      if (!item) continue;
      entries.push({
        key: `stalled:${r.id}`,
        kind: "stalled",
        title: item.title,
        question: `@${r.profile}'s run "${r.title}" hasn't reported in over ${STALL_AFTER_MIN} min. Check on it; nothing was changed.`,
        choices: [],
        href: `/areas?item=${encodeURIComponent(item.id)}`,
        at: r.updatedAt,
        itemId: item.id,
        areaTitle: live.get(areaOf!.get(item.id) ?? "")?.title,
      });
    }
  }
  const sorted = sortDecisions(entries);
  return { entries: sorted, count: sorted.length };
}

export function linksByItem(ids: string[]) {
  const out = new Map<string, { kind: string; targetId: string | null; url: string | null; title: string }[]>();
  const db = getDb();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = db
      .select({
        itemId: schema.workLinks.itemId,
        kind: schema.workLinks.kind,
        targetId: schema.workLinks.targetId,
        url: schema.workLinks.url,
        title: schema.workLinks.title,
      })
      .from(schema.workLinks)
      .where(inArray(schema.workLinks.itemId, ids.slice(i, i + 500)))
      .all();
    for (const r of rows) out.set(r.itemId, [...(out.get(r.itemId) ?? []), r]);
  }
  return out;
}

export type MapLink = { kind: string; url: string; title: string | null };
/** A relation chip on the area tree: "depends on <x>" (work_dependencies) or "follow-up of <x>" (reopen hand-off lineage). */
export type MapRelation = { kind: "depends" | "followup"; id: string; title: string; open: boolean };
export type MapResponse = {
  items: WorkItem[];
  links: Record<string, MapLink[]>;
  relations: Record<string, MapRelation[]>;
  decisions: DecisionsResponse;
};

const chatUrl = (sessionId: string) => `/chat/${encodeURIComponent(sessionId)}`;

/** Everything /map renders in one read: items, their links (PRs, boards, chats) and the "Needs you" list. */
export function mapData(user: CurrentUser, opts: { includeArchived?: boolean } = {}): MapResponse {
  const items = listItems(user.id, { includeArchived: opts.includeArchived });
  const raw = linksByItem(items.map((i) => i.id));
  const links: Record<string, MapLink[]> = {};
  for (const [id, ls] of raw) {
    const out = ls
      .map((l) => ({ kind: l.kind, url: l.kind === "chat_session" && l.targetId ? chatUrl(l.targetId) : (l.url ?? ""), title: l.title || null }))
      .filter((l) => l.url.startsWith("/") || /^https?:\/\//.test(l.url));
    if (out.length) links[id] = out;
  }
  return { items, links, relations: relationsByItem(user.id, items), decisions: listDecisions(user, items) };
}

const CLOSED = new Set(["settled", "superseded", "abandoned"]);

/** Dependency and follow-up relations between the user's live items (both ends must exist and be unarchived). */
export function relationsByItem(userId: string, items: WorkItem[]): Record<string, MapRelation[]> {
  const byId = new Map(items.filter((i) => !i.archived).map((i) => [i.id, i]));
  const out: Record<string, MapRelation[]> = {};
  const add = (id: string, r: MapRelation) => (out[id] ??= []).push(r);
  const db = getDb();
  for (const d of db.select().from(schema.workDependencies).where(eq(schema.workDependencies.userId, userId)).all()) {
    const on = byId.get(d.dependsOnId);
    if (byId.has(d.itemId) && on) add(d.itemId, { kind: "depends", id: on.id, title: on.title, open: !CLOSED.has(on.status) });
  }
  const lineage = db
    .select()
    .from(schema.workLineage)
    .where(and(eq(schema.workLineage.userId, userId), eq(schema.workLineage.relation, "handoff_from")))
    .all();
  for (const l of lineage) {
    const src = l.parentId ? byId.get(l.parentId) : undefined;
    if (byId.has(l.childId) && src) add(l.childId, { kind: "followup", id: src.id, title: src.title, open: !CLOSED.has(src.status) });
  }
  return out;
}

/** JSON export of the map (import into a draft area is follow-up #153). */
export function mapExport(user: CurrentUser, now = new Date()): MapExport {
  const { items, links } = mapData(user);
  const live = items.filter((i) => !i.archived);
  const kids = new Map<string | null, WorkItem[]>();
  for (const i of live) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  const node = (i: WorkItem, depth = 0): MapExportNode => ({
    id: i.id,
    title: i.title,
    kind: i.kind,
    status: i.status,
    bucket: bucketOf(i),
    nextAction: i.nextAction,
    tags: i.tags,
    assignee: i.assignee,
    decision: i.decision,
    links: links[i.id] ?? [],
    children: depth > 50 ? [] : (kids.get(i.id) ?? []).map((c) => node(c, depth + 1)),
  });
  return {
    version: 1,
    exportedAt: now.toISOString(),
    areas: areaRollups(live).map((r) => ({ ...r, tree: (kids.get(r.id) ?? []).map((c) => node(c)) })),
  };
}
