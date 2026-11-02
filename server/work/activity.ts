import "server-only";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { latestOp, undoCheck } from "@/server/work/undo-rules";
import { AUTO_SETTLE_UNDO_MS } from "@/server/work/settle-rules";
import {
  compareActivity,
  decodeCursor,
  encodeCursor,
  isBefore,
  matchesFilter,
  normalizeWorkEvent,
  pageActivity,
  sortActivity,
  type ActivityFilter,
  type ActivityItem,
  type ActivityResponse,
} from "@/lib/activity";

type SortKey = { at: string; id: string; seq?: number };

/** Rows per source per window (#130: windows continue past it, so this is no longer a history cap). */
let SOURCE_CAP = 2000;
/** Tests: shrink the window to exercise paging past it. */
export function __setActivitySourceCap(n: number) {
  SOURCE_CAP = n;
}
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
  // #131: due-date edits, the new item's creation (split/fork op lives on it), drag reorders
  dates: ["edit"],
  created: ["split", "fork"],
  reordered: ["reorder", "move"],
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
  if (!ids.length) return pageActivity([], q);

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  const ops = chunks.flatMap((c) =>
    db
      .select({ ...getTableColumns(schema.workOps), seq: sql<number>`"work_ops"."rowid"` })
      .from(schema.workOps)
      .where(and(eq(schema.workOps.userId, user.id), inArray(schema.workOps.itemId, c)))
      .all(),
  );
  const opsByItem = new Map<string, typeof ops>();
  for (const o of ops) opsByItem.set(o.itemId, [...(opsByItem.get(o.itemId) ?? []), o]);
  const usedOps = new Set<string>();
  const sessions = new Map<string, { id: string; title: string }>();
  for (const id of ids) {
    const r = byId.get(id);
    if (r?.sessionId) sessions.set(r.sessionId, { id: r.id, title: r.title });
  }
  const sids = [...sessions.keys()];

  /**
   * #130: one window of every source, older than `cur` (the bound is pushed into each query). A source
   * that returns SOURCE_CAP rows may have more past its oldest row, so rows older than the newest such
   * "horizon" aren't complete yet: they're dropped and the next window starts at the horizon.
   */
  const windowAt = (cur: SortKey | null) => {
    const out: ActivityItem[] = [];
    let horizon: SortKey | null = null;
    const capped = (key: SortKey) => {
      if (!horizon || compareActivity(key, horizon) < 0) horizon = key;
    };
    const evBound = cur
      ? cur.seq === undefined
        ? sql`"work_events"."at" < ${cur.at}`
        : sql`("work_events"."at" < ${cur.at} or ("work_events"."at" = ${cur.at} and "work_events"."rowid" < ${cur.seq}))`
      : undefined;
    const events = chunks
      .flatMap((c) => {
        const rows = db
          .select({ ...getTableColumns(schema.workEvents), seq: sql<number>`"work_events"."rowid"` })
          .from(schema.workEvents)
          .where(and(inArray(schema.workEvents.itemId, c), evBound))
          .orderBy(desc(schema.workEvents.at), desc(sql`"work_events"."rowid"`))
          .limit(SOURCE_CAP)
          .all();
        const last = rows[rows.length - 1];
        if (rows.length === SOURCE_CAP && last) capped({ at: last.at, id: `ev:${last.id}`, seq: last.seq });
        return rows;
      })
      // Newest first; same millisecond → insertion order (rowid), never the random id.
      .sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1));
    for (const e of events) {
      const item: ActivityItem = { ...normalizeWorkEvent(e, user.id, byId.get(e.itemId)?.title ?? null), seq: e.seq };
      const kinds = OP_FOR_EVENT[e.kind];
      // #131: an automatic settle is a `jarvis` status event with a viewer-owned settle op.
      const auto = e.actor === "jarvis" && e.kind === "status";
      if (kinds && (e.actor === user.id || auto)) {
        const t = Date.parse(e.at);
        const itemOps = opsByItem.get(e.itemId) ?? [];
        // Closest op in time wins (ties → newest, then insertion order) so two quick edits never swap Undo targets.
        let op: (typeof itemOps)[number] | undefined;
        let best = Infinity;
        for (const o of itemOps) {
          if (usedOps.has(o.id) || !kinds.includes(o.kind) || (auto && o.kind !== "settle")) continue;
          const d = Math.abs(Date.parse(o.createdAt) - t);
          if (d > OP_MATCH_MS) continue;
          if (d < best || (d === best && op && (o.createdAt > op.createdAt || (o.createdAt === op.createdAt && o.seq > op.seq)))) {
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
    const inbox = chunks.flatMap((c) => {
      const rows = db
        .select({
          id: schema.workInbox.id,
          title: schema.workInbox.title,
          source: schema.workInbox.source,
          acceptedAt: schema.workInbox.acceptedAt,
          acceptedItemId: schema.workInbox.acceptedItemId,
          createdAt: schema.workInbox.createdAt,
        })
        .from(schema.workInbox)
        .where(
          and(
            eq(schema.workInbox.userId, user.id),
            inArray(schema.workInbox.acceptedItemId, c),
            cur ? sql`"work_inbox"."accepted_at" <= ${cur.at}` : sql`"work_inbox"."accepted_at" is not null`,
          ),
        )
        .orderBy(desc(schema.workInbox.acceptedAt))
        .limit(SOURCE_CAP)
        .all();
      const last = rows[rows.length - 1];
      if (rows.length === SOURCE_CAP && last?.acceptedAt) capped({ at: last.acceptedAt, id: `in:${last.id}` });
      return rows;
    });
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
        .where(
          and(eq(schema.runs.userId, user.id), inArray(schema.runs.sessionId, sids.slice(i, i + 500)), cur ? sql`"runs"."started_at" <= ${cur.at}` : undefined),
        )
        .orderBy(desc(schema.runs.startedAt))
        .limit(SOURCE_CAP)
        .all();
      const last = runs[runs.length - 1];
      if (runs.length === SOURCE_CAP && last) capped({ at: last.startedAt, id: `run:${last.runId}` });
      for (const r of runs) {
        const node = sessions.get(r.sessionId)!;
        const waiting = Boolean(r.pending) || r.status === "waiting_for_approval";
        out.push({
          id: `run:${r.runId}`,
          at: r.startedAt,
          type: "chat",
          actor: { kind: "agent", name: r.profile || "Hermes" },
          verb: waiting
            ? "asked for approval in"
            : r.status === "failed"
              ? "run failed in"
              : r.status === "running"
                ? "is working in"
                : // #131: a stopped/interrupted run didn't reply
                  r.status === "cancelled"
                  ? "was stopped in"
                  : r.status === "interrupted"
                    ? "was interrupted in"
                    : "replied in",
          object: node,
          detail: null,
          undoOpId: null,
        });
      }
    }

    const h = horizon as SortKey | null;
    const complete = (cur ? out.filter((i) => isBefore(i, cur)) : out).filter((i) => !h || compareActivity(i, h) <= 0);
    return { items: complete, horizon: h };
  };

  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  let cur = decodeCursor(q.cursor);
  const collected: ActivityItem[] = [];
  let latestAt: string | null = null;
  // Walk windows until the page (+1 to know there's more) is full or the sources run out.
  for (let i = 0; i < 50; i++) {
    const w = windowAt(cur);
    const matched = w.items.filter((x) => matchesFilter(x, q));
    if (i === 0 && !q.cursor) latestAt = sortActivity(matched)[0]?.at ?? null;
    collected.push(...matched);
    if (collected.length > limit || !w.horizon) {
      const page = pageActivity(collected, { limit });
      return { ...page, latestAt: q.cursor ? (page.items[0]?.at ?? null) : latestAt };
    }
    cur = w.horizon;
  }
  // Safety stop: continue from the last window boundary on the next Load older.
  const page = pageActivity(collected, { limit });
  return { ...page, nextCursor: page.nextCursor ?? (cur ? encodeCursor(cur) : null), latestAt };
}
