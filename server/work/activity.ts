import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { latestOp, undoCheck } from "@/server/work/undo-rules";
import { AUTO_SETTLE_UNDO_MS } from "@/server/work/settle-rules";
import { normalizeWorkEvent, pageActivity, type ActivityFilter, type ActivityItem, type ActivityResponse } from "@/lib/activity";

/** Per scope we read at most this many rows of each source (paging happens over the merged list). */
const SOURCE_CAP = 2000;
/** An op and its work_event are written in one transaction; match them within this window. */
const OP_MATCH_MS = 2000;

const OP_FOR_EVENT: Record<string, string[]> = {
  edit: ["edit"],
  status: ["edit", "settle"],
  archived: ["archive"],
  unarchived: ["unarchive"],
  moved: ["move", "reorder"],
  move: ["move", "reorder"],
  reorder: ["reorder"],
  split: ["split"],
  fork: ["fork"],
  forked: ["fork"],
};

export type ActivityQuery = ActivityFilter & {
  /** an item id: that item only, or with `descendants` its whole subtree (areas/projects) */
  item?: string | null;
  descendants?: boolean;
  cursor?: string | null;
  limit?: number;
};

/**
 * The viewer's unified activity: work_events (edits, status, created, links, merges), Inbox filing
 * and chat runs/approvals on conversation nodes. Only the viewer's own work items are read, so
 * nothing outside what they can already open is shown; chat rows never carry run input text
 * (finance or other sensitive prompts stay in the conversation, behind its own checks).
 */
export function listActivity(user: CurrentUser, q: ActivityQuery, now = new Date()): ActivityResponse {
  const db = getDb();
  const rows = db
    .select({
      id: schema.workItems.id,
      parentId: schema.workItems.parentId,
      title: schema.workItems.title,
      kind: schema.workItems.kind,
      sessionId: schema.workItems.sessionId,
    })
    .from(schema.workItems)
    .where(eq(schema.workItems.userId, user.id))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  let scope: Set<string> | null = null;
  if (q.item) {
    if (!byId.has(q.item)) throw new HttpError(404, "not_found", "That item isn't here");
    scope = new Set([q.item]);
    if (q.descendants) {
      const kids = new Map<string, string[]>();
      for (const r of rows) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id]);
      const stack = [q.item];
      while (stack.length) {
        for (const k of kids.get(stack.pop()!) ?? []) {
          if (scope.has(k)) continue;
          scope.add(k);
          stack.push(k);
        }
      }
    }
  }
  const ids = scope ? [...scope] : rows.map((r) => r.id);
  const out: ActivityItem[] = [];
  if (!ids.length) return pageActivity(out, q);

  // work_events (+ undo ops) — chunk the IN list to stay under SQLite's variable limit.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  const events = chunks
    .flatMap((c) => db.select().from(schema.workEvents).where(inArray(schema.workEvents.itemId, c)).orderBy(desc(schema.workEvents.at)).limit(SOURCE_CAP).all())
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
  const ops = chunks.flatMap((c) =>
    db
      .select()
      .from(schema.workOps)
      .where(and(eq(schema.workOps.userId, user.id), inArray(schema.workOps.itemId, c)))
      .all(),
  );
  const opsByItem = new Map<string, typeof ops>();
  for (const o of ops) opsByItem.set(o.itemId, [...(opsByItem.get(o.itemId) ?? []), o]);
  const usedOps = new Set<string>();
  for (const e of events) {
    const item = normalizeWorkEvent(e, user.id, byId.get(e.itemId)?.title ?? null);
    const kinds = OP_FOR_EVENT[e.kind];
    if (kinds && e.actor === user.id) {
      const t = Date.parse(e.at);
      const itemOps = opsByItem.get(e.itemId) ?? [];
      // Closest op in time wins (ties → newest, then id) so two quick edits never swap Undo targets.
      let op: (typeof itemOps)[number] | undefined;
      let best = Infinity;
      for (const o of itemOps) {
        if (usedOps.has(o.id) || !kinds.includes(o.kind)) continue;
        const d = Math.abs(Date.parse(o.createdAt) - t);
        if (d > OP_MATCH_MS) continue;
        if (d < best || (d === best && op && (o.createdAt > op.createdAt || (o.createdAt === op.createdAt && o.id > op.id)))) {
          op = o;
          best = d;
        }
      }
      if (op) {
        usedOps.add(op.id);
        const stack = itemOps.filter((o) => (o.kind === "edit") === (op.kind === "edit"));
        const check = undoCheck(op, latestOp(stack)?.id ?? null, now, op.kind === "settle" ? AUTO_SETTLE_UNDO_MS : undefined);
        if (check.ok) item.undoOpId = op.id;
      }
    }
    out.push(item);
  }

  // Inbox filing: captures accepted into an item in scope.
  const inbox = chunks.flatMap((c) =>
    db
      .select({
        id: schema.workInbox.id,
        title: schema.workInbox.title,
        source: schema.workInbox.source,
        acceptedAt: schema.workInbox.acceptedAt,
        acceptedItemId: schema.workInbox.acceptedItemId,
        createdAt: schema.workInbox.createdAt,
      })
      .from(schema.workInbox)
      .where(and(eq(schema.workInbox.userId, user.id), inArray(schema.workInbox.acceptedItemId, c)))
      .limit(SOURCE_CAP)
      .all(),
  );
  for (const r of inbox) {
    if (!r.acceptedAt || !r.acceptedItemId) continue;
    out.push({
      id: `in:${r.id}`,
      at: r.acceptedAt,
      type: "capture",
      actor: { kind: "you", name: "You" },
      verb: r.source === "conversation" ? "filed a chat into" : "filed a capture into",
      object: { id: r.acceptedItemId, title: byId.get(r.acceptedItemId)?.title ?? "Untitled" },
      detail: r.title || null,
      undoOpId: null,
    });
  }

  // Chat runs + approvals on conversation nodes in scope (no input text).
  const sessions = new Map<string, { id: string; title: string }>();
  for (const id of ids) {
    const r = byId.get(id);
    if (r?.sessionId) sessions.set(r.sessionId, { id: r.id, title: r.title });
  }
  const sids = [...sessions.keys()];
  for (let i = 0; i < sids.length; i += 500) {
    const runs = db
      .select({
        runId: schema.runs.runId,
        sessionId: schema.runs.sessionId,
        status: schema.runs.status,
        pending: schema.runs.pendingApproval,
        startedAt: schema.runs.startedAt,
        profile: schema.runs.hermesProfile,
      })
      .from(schema.runs)
      .where(and(eq(schema.runs.userId, user.id), inArray(schema.runs.sessionId, sids.slice(i, i + 500))))
      .orderBy(desc(schema.runs.startedAt))
      .limit(SOURCE_CAP)
      .all();
    for (const r of runs) {
      const node = sessions.get(r.sessionId)!;
      const waiting = Boolean(r.pending) || r.status === "waiting_for_approval";
      out.push({
        id: `run:${r.runId}`,
        at: r.startedAt,
        type: "chat",
        actor: { kind: "agent", name: r.profile || "Hermes" },
        verb: waiting ? "asked for approval in" : r.status === "failed" ? "run failed in" : r.status === "running" ? "is working in" : "replied in",
        object: node,
        detail: null,
        undoOpId: null,
      });
    }
  }

  return pageActivity(out, q);
}
