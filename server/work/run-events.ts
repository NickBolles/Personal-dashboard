import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type DB } from "@/server/db";
import { pushRunTransition } from "./cw-push";
import { newId } from "@/server/crypto";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { AGENT_RUN_STATES, isStalled, type AgentRunState } from "@/lib/agent-runs";
import {
  LOOK_SURFACES,
  RUN_EVENT_TYPES,
  RUN_REF,
  parseLock,
  parsePipeline,
  parseRunRef,
  runRef,
  type LookSurface,
  type RunEvent,
  type RunEventType,
} from "@/lib/cw-runs";
import type { WorkItem } from "@/lib/work";
import { listItems } from "./store";

type RunDb = Pick<DB, "select" | "insert" | "update">;
const T = schema.agentRuns;
const E = schema.runEvents;
/** Run ids are opaque Jarvis ids; malformed R-n references never fall back to ids. */
export const runIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?:R-[1-9]\d{0,8}|(?!R-)[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/);

/** Call inside the insert transaction. The durable high-water mark also survives mirror pruning. */
export function nextRunSeq(db: RunDb, userId: string): number {
  const max = db
    .select({ seq: sql<number>`coalesce(max(${T.seq}), 0)` })
    .from(T)
    .where(eq(T.userId, userId))
    .get()!.seq;
  const key = `cw:run-seq:${userId}`;
  const prior = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  const seq = Math.max(max, Number(prior?.value) || 0) + 1;
  db.insert(schema.settings)
    .values({ key, value: String(seq) })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: String(seq), updatedAt: new Date().toISOString() },
    })
    .run();
  return seq;
}

/** Backfill legacy/missed insert paths without changing any already-assigned reference. */
export function ensureRunSeqs(userId: string) {
  const db = getDb();
  if (
    !db
      .select({ id: T.id })
      .from(T)
      .where(and(eq(T.userId, userId), isNull(T.seq)))
      .limit(1)
      .get()
  )
    return;
  db.transaction(
    (tx) => {
      const rows = tx
        .select({ id: T.id })
        .from(T)
        .where(and(eq(T.userId, userId), isNull(T.seq)))
        .orderBy(asc(T.startedAt), asc(T.id))
        .all();
      for (const r of rows)
        tx.update(T)
          .set({ seq: nextRunSeq(tx, userId) })
          .where(eq(T.id, r.id))
          .run();
    },
    { behavior: "immediate" },
  );
}

export function resolveRun(userId: string, identifier: string, db: RunDb = getDb()) {
  if (!runIdentifier.safeParse(identifier).success) throw new HttpError(404, "not_found", "No run with that reference");
  const seq = RUN_REF.test(identifier) ? parseRunRef(identifier) : null;
  const row = db
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), seq === null ? eq(T.id, identifier) : eq(T.seq, seq)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "No run with that reference");
  return row;
}

export function recordRunEvent(
  db: RunDb,
  input: {
    userId: string;
    runId: string;
    type: RunEventType;
    summary: string;
    payload?: Record<string, unknown>;
    via?: string | null;
  },
) {
  const payloadJson = JSON.stringify(z.record(z.string(), z.unknown()).parse(input.payload ?? {}));
  if (Buffer.byteLength(payloadJson, "utf8") > 4096) throw new HttpError(400, "payload_too_large", "Run event payload must be at most 4 KB");
  const type = z.enum(RUN_EVENT_TYPES).parse(input.type);
  const summary = z.string().max(300).parse(input.summary);
  resolveRun(input.userId, input.runId, db);
  const id = newId("revt");
  db.insert(E)
    .values({ id, userId: input.userId, runId: input.runId, type, summary, payloadJson, via: input.via ?? null })
    .run();
  return id;
}

function wire(row: typeof E.$inferSelect, seq: number | null): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    runRef: runRef(seq),
    type: row.type as RunEventType,
    summary: row.summary,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    via: row.via,
    at: row.createdAt,
  };
}

export function listRunEvents(userId: string, opts: { runIds?: string[]; since?: string; limit?: number } = {}): RunEvent[] {
  ensureRunSeqs(userId);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(opts.limit ?? 100);
  const since = opts.since === undefined ? undefined : new Date(z.string().datetime({ offset: true }).parse(opts.since)).toISOString();
  if (opts.runIds?.length === 0) return [];
  return getDb()
    .select({ event: E, seq: T.seq })
    .from(E)
    .innerJoin(T, and(eq(T.id, E.runId), eq(T.userId, E.userId)))
    .where(and(eq(E.userId, userId), opts.runIds ? inArray(E.runId, opts.runIds) : undefined, since ? gt(E.createdAt, since) : undefined))
    .orderBy(desc(E.createdAt), sql`${E}.rowid desc`)
    .limit(limit)
    .all()
    .reverse()
    .map((r) => wire(r.event, r.seq));
}

/** Owner visibility matches agent-runs: private owner tree, excluding archived branches. */
export function runTree(user: CurrentUser, items: WorkItem[] = listItems(user.id)) {
  ensureRunSeqs(user.id);
  const db = getDb();
  // Intersect caller-provided items with the actual owner's live tree as a defence in depth.
  const live = new Map(
    listItems(user.id)
      .filter((i) => !i.archived)
      .map((i) => [i.id, i]),
  );
  const byId = new Map(items.filter((i) => live.has(i.id) && !i.archived).map((i) => [i.id, live.get(i.id)!]));
  if (!byId.size) return { runs: [] };
  const rows = db
    .select()
    .from(T)
    .where(and(eq(T.userId, user.id), inArray(T.itemId, [...byId.keys()])))
    .orderBy(
      sql`case when ${T.state} in ('failed','waiting','interrupted') then 0 when ${T.state} = 'running' then 1 else 2 end`,
      desc(T.updatedAt),
      desc(T.seq),
    )
    .limit(200)
    .all();
  const ids = rows.map((r) => r.id);
  const stats = ids.length
    ? db
        .select({ runId: E.runId, notices: sql<number>`sum(case when ${E.type} = 'notice' then 1 else 0 end)`, last: sql<number>`max(${E}.rowid)` })
        .from(E)
        .where(and(eq(E.userId, user.id), inArray(E.runId, ids)))
        .groupBy(E.runId)
        .all()
    : [];
  const counts = new Map(stats.map((s) => [s.runId, s.notices]));
  const events = stats.length
    ? db
        .select()
        .from(E)
        .where(
          and(
            eq(E.userId, user.id),
            inArray(
              sql<number>`${E}.rowid`,
              stats.map((s) => s.last),
            ),
          ),
        )
        .all()
    : [];
  const last = new Map(events.map((e) => [e.runId, e]));
  const parentIds = [...new Set(rows.flatMap((r) => (r.parentRunId ? [r.parentRunId] : [])))];
  const parents = new Map(
    parentIds.length
      ? db
          .select({ id: T.id, seq: T.seq, itemId: T.itemId })
          .from(T)
          .where(and(eq(T.userId, user.id), inArray(T.id, parentIds)))
          .all()
          .filter((r) => live.has(r.itemId))
          .map((r) => [r.id, r.seq])
      : [],
  );
  return {
    runs: rows.map((r) => {
      const state: AgentRunState = (AGENT_RUN_STATES as readonly string[]).includes(r.state) ? (r.state as AgentRunState) : "running";
      const event = last.get(r.id);
      return {
        id: r.id,
        ref: runRef(r.seq)!,
        seq: r.seq!,
        itemId: r.itemId,
        itemTitle: byId.get(r.itemId)!.title,
        profile: r.profile,
        title: r.title,
        state,
        stalled: isStalled({ state, updatedAt: r.updatedAt }),
        summary: r.summary,
        prUrl: r.prUrl,
        parentRunId: r.parentRunId && parents.has(r.parentRunId) ? r.parentRunId : null,
        parentRef: r.parentRunId ? runRef(parents.get(r.parentRunId)) : null,
        pipeline: parsePipeline(r.pipelineJson),
        lock: parseLock(r.lockJson),
        interruptedAt: r.interruptedAt,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        finishedAt: r.finishedAt,
        ...(event ? { lastEvent: wire(event, r.seq) } : {}),
        noticeCount: counts.get(r.id) ?? 0,
      };
    }),
  };
}

export function lastLooked(userId: string): Record<LookSurface, string | null> {
  const out: Record<LookSurface, string | null> = { chat: null, needs: null, running: null, changes: null, context: null };
  for (const r of getDb().select().from(schema.ownerMarkers).where(eq(schema.ownerMarkers.userId, userId)).all()) {
    if ((LOOK_SURFACES as readonly string[]).includes(r.surface)) out[r.surface as LookSurface] = r.lastLookedAt;
  }
  return out;
}

export function markLooked(userId: string, surface: LookSurface, at = new Date().toISOString()) {
  z.enum(LOOK_SURFACES).parse(surface);
  const time = Date.parse(z.string().datetime({ offset: true }).parse(at));
  const lastLookedAt = new Date(Math.min(time, Date.now())).toISOString();
  getDb()
    .insert(schema.ownerMarkers)
    .values({ userId, surface, lastLookedAt })
    .onConflictDoUpdate({
      target: [schema.ownerMarkers.userId, schema.ownerMarkers.surface],
      set: { lastLookedAt },
    })
    .run();
  return lastLooked(userId);
}

/** Exactly one system event for a transition; heartbeats never create duplicates. */
export function recordRunTransition(db: RunDb, run: typeof T.$inferSelect, state: AgentRunState, summary: string | undefined, via: string) {
  if (run.state === state) return;
  const type = state === "running" ? "resumed" : state === "done" || state === "failed" || state === "interrupted" ? state : null;
  if (type) recordRunEvent(db, { userId: run.userId, runId: run.id, type, summary: (summary ?? run.summary ?? run.title).slice(0, 300), via });
  // CW-5: a failed run or an ended session (interrupted) interrupts the owner; done/resumed never push.
  if (state === "failed" || state === "interrupted") pushRunTransition(run, state);
}
