import "server-only";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { config } from "@/server/config";
import { processSingleton } from "@/server/singleton";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { formatSse, SseParser } from "@/lib/sse";
import { isTerminal, type RunEvent, type RunView, type SessionSummary } from "@/lib/hermes";
import { getOwner, type CurrentUser } from "@/server/auth";
import { hermesConn, HermesExecutionClient, HermesSessionClient } from "./client";
import { messagesToTimeline, normalizeApproval, normalizeRunEvent, normalizeSession } from "./normalize";
import { SYNC_SESSION_SOURCE } from "./structured";
import { RUN_TERMINAL, runEventSchema } from "./types";

const db = () => getDb();

function metaFor(ids: string[]) {
  if (!ids.length) return new Map<string, typeof schema.sessionMeta.$inferSelect>();
  const rows = db().select().from(schema.sessionMeta).where(inArray(schema.sessionMeta.sessionId, ids)).all();
  return new Map(rows.map((r) => [r.sessionId, r]));
}

function activeRunsFor(ids: string[]) {
  if (!ids.length) return new Map<string, typeof schema.runs.$inferSelect>();
  const rows = db()
    .select()
    .from(schema.runs)
    .where(and(inArray(schema.runs.sessionId, ids), notInArray(schema.runs.status, [...RUN_TERMINAL])))
    .all();
  return new Map(rows.map((r) => [r.sessionId, r]));
}

type Meta = typeof schema.sessionMeta.$inferSelect;

/**
 * Conversations are private to the person who started them. Sessions Jarvis
 * didn't create (made in Hermes directly) belong to the owner. A shared one is
 * readable (and forkable) by everyone who can chat; only its owner writes to it.
 */
function access(user: CurrentUser, m: Meta | undefined, ownerId = getOwner()?.id): "write" | "read" | null {
  const owner = m?.userId ?? ownerId;
  if (owner === user.id) return "write";
  return m?.shared ? "read" : null;
}

export function sessionAccess(user: CurrentUser, id: string) {
  return access(user, metaFor([id]).get(id));
}

function assertAccess(user: CurrentUser, id: string, need: "read" | "write") {
  const a = sessionAccess(user, id);
  if (!a) throw new HttpError(404, "session_not_found", "Conversation not found");
  if (need === "write" && a !== "write") throw new HttpError(403, "read_only", "This conversation was shared with you read-only. Fork it to continue.");
}

function decorate(list: SessionSummary[], user?: CurrentUser): SessionSummary[] {
  const ids = list.map((s) => s.id);
  const meta = metaFor(ids);
  const runs = activeRunsFor(ids);
  const ownerId = getOwner()?.id;
  const visible = user ? list.filter((s) => access(user, meta.get(s.id), ownerId)) : list;
  return visible.map((s) => {
    const m = meta.get(s.id);
    const r = runs.get(s.id);
    return {
      ...s,
      shared: Boolean(m?.shared),
      readOnly: user ? access(user, m, ownerId) === "read" : undefined,
      title: m?.titleOverride ?? s.title,
      forkedFromSessionId: m?.forkedFromSessionId ?? undefined,
      forkedFromMessageId: m?.forkedFromMessageId ?? undefined,
      parentSessionId: s.parentSessionId ?? m?.forkedFromSessionId ?? undefined,
      activeRun: r
        ? {
            runId: r.runId,
            status: r.status,
            pendingApproval: r.pendingApproval ? JSON.parse(r.pendingApproval) : undefined,
          }
        : undefined,
    };
  });
}

function touchMeta(user: CurrentUser, sessionId: string, patch: Partial<typeof schema.sessionMeta.$inferInsert> = {}) {
  const insert = db()
    .insert(schema.sessionMeta)
    .values({ sessionId, userId: user.id, ...patch });
  if (Object.keys(patch).length) insert.onConflictDoUpdate({ target: schema.sessionMeta.sessionId, set: { ...patch } }).run();
  else insert.onConflictDoNothing().run();
}

/** Refuse IDs that look malformed so arbitrary strings never reach upstream paths. */
export function assertSessionId(id: string) {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) throw new HttpError(400, "bad_session_id", "Invalid session id");
}

function assertRunOwner(user: CurrentUser, runId: string) {
  const run = db().select().from(schema.runs).where(eq(schema.runs.runId, runId)).get();
  if (!run || run.userId !== user.id) throw new HttpError(404, "run_not_found", "Run not found");
  return run;
}

export async function listSessions(user: CurrentUser, opts: { includeArchived?: boolean } = {}) {
  const res = await HermesSessionClient.list(hermesConn(), { limit: 100, includeChildren: true });
  // Hidden sessions (e.g. Jarvis's own structured sync requests) never show in chat.
  const visible = res.data.filter((s) => !s.hidden && s.source !== SYNC_SESSION_SOURCE);
  const sessions = decorate(visible.map(normalizeSession), user);
  return sessions.filter((s) => opts.includeArchived || !s.archived);
}

export async function getSessionDetail(user: CurrentUser, id: string) {
  assertSessionId(id);
  assertAccess(user, id, "read");
  const conn = hermesConn();
  const [session, messages] = await Promise.all([HermesSessionClient.get(conn, id), HermesSessionClient.messages(conn, id, { order: "latest", limit: 500 })]);
  const [summary] = decorate([normalizeSession(session.session)], user);
  // Children (forks) of this session, for reciprocal lineage links.
  const all = await HermesSessionClient.list(conn, { limit: 200, includeChildren: true }).catch(() => ({ data: [] }));
  const localChildren = db().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.forkedFromSessionId, id)).all();
  const childIds = new Set([...all.data.filter((s) => s.parent_session_id === id).map((s) => s.id), ...localChildren.map((c) => c.sessionId)]);
  const children = decorate(all.data.filter((s) => childIds.has(s.id)).map(normalizeSession), user);
  let parent: SessionSummary | undefined;
  if (summary!.parentSessionId) {
    const p = all.data.find((s) => s.id === summary!.parentSessionId);
    if (p) parent = decorate([normalizeSession(p)], user)[0];
  }
  return {
    session: summary!,
    timeline: messagesToTimeline(messages.data),
    parent,
    children,
  };
}

export async function createSession(user: CurrentUser, title?: string) {
  const conn = hermesConn();
  const res = await HermesSessionClient.create(conn, { title: title?.trim() || undefined, source: "api_server" });
  touchMeta(user, res.session.id);
  return decorate([normalizeSession(res.session)], user)[0]!;
}

export async function updateSession(
  user: CurrentUser,
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; shared?: boolean },
  correlationId: string,
) {
  assertSessionId(id);
  assertAccess(user, id, "write");
  const { shared, ...upstream } = patch;
  const res = Object.keys(upstream).length ? await HermesSessionClient.update(hermesConn(), id, upstream) : await HermesSessionClient.get(hermesConn(), id);
  touchMeta(user, id, {
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(shared !== undefined ? { shared } : {}),
  });
  audit({ actor: user.id, action: "hermes.session.update", source: "hermes", sourceRecord: id, result: "ok", correlationId, detail: patch });
  return decorate([normalizeSession(res.session)], user)[0]!;
}

export type ForkInput = {
  title?: string;
  /** fork at an earlier message instead of the latest state */
  fromMessageId?: string;
  prompt?: string;
  idempotencyKey?: string;
};

/**
 * Fork a conversation.
 *  - Latest state: Hermes' native POST /api/sessions/:id/fork (copies the full
 *    transcript into a child; Hermes marks the source end_reason=branched but
 *    leaves its messages untouched).
 *  - From a specific message: the pinned Hermes version has no HTTP fork-point,
 *    so a text-only restart seeds conversation_history up to that message.
 *    Refuse unverified/truncated windows and unsupported context before writes.
 *    This does not copy the parent's model/system configuration. Lineage is local.
 */
export async function forkSession(user: CurrentUser, id: string, input: ForkInput, correlationId: string) {
  assertSessionId(id);
  assertAccess(user, id, "read");
  const conn = hermesConn();
  let child: SessionSummary;
  let run: RunView | undefined;
  if (!input.fromMessageId) {
    const res = await HermesSessionClient.fork(conn, id, { title: input.title?.trim() || undefined });
    child = normalizeSession(res.session);
    touchMeta(user, child.id, { forkedFromSessionId: id });
  } else {
    if (!input.prompt?.trim()) {
      throw new HttpError(400, "prompt_required", "Forking from an earlier message needs a first prompt.");
    }
    // The HTTP API has no fork-point operation. Only seed a verified complete,
    // bounded text transcript; never silently drop an older window or tool context.
    const messages = await HermesSessionClient.messages(conn, id, { order: "oldest", limit: 500, offset: 0, includeCompacted: true });
    const pagination = messages.pagination;
    if (
      !pagination ||
      pagination.order !== "oldest" ||
      pagination.offset !== 0 ||
      pagination.limit !== 500 ||
      pagination.returned !== messages.data.length ||
      messages.data.length >= 500 ||
      pagination.has_more === true ||
      new Set(messages.data.map((m) => String(m.id))).size !== messages.data.length
    ) {
      throw new HttpError(409, "fork_history_incomplete", "Cannot verify a complete transcript below the 500-message limit. Use Fork latest state instead.");
    }
    const idx = messages.data.findIndex((m) => String(m.id) === input.fromMessageId);
    if (idx === -1) throw new HttpError(404, "message_not_found", "That message is no longer in the conversation");
    const history = messages.data.slice(0, idx + 1).map((m) => {
      if (
        (m.role !== "user" && m.role !== "assistant") ||
        typeof m.content !== "string" ||
        m.tool_calls?.length ||
        m.tool_call_id ||
        m.tool_name ||
        m.reasoning ||
        m.reasoning_content ||
        m.display_kind ||
        (m.finish_reason && m.finish_reason !== "stop")
      ) {
        throw new HttpError(
          409,
          "fork_context_unsupported",
          "Text-only restart cannot preserve this tool, reasoning, or non-text context. Use Fork latest state instead.",
        );
      }
      return { role: m.role, content: m.content };
    });
    const parent = await HermesSessionClient.get(conn, id);
    const created = await HermesSessionClient.create(conn, {
      title: input.title?.trim() || `${parent.session.title ?? "Conversation"} (fork)`,
      source: "api_server",
    });
    child = normalizeSession(created.session);
    touchMeta(user, child.id, { forkedFromSessionId: id, forkedFromMessageId: input.fromMessageId });
    run = await startRun(
      user,
      {
        sessionId: child.id,
        input: input.prompt,
        idempotencyKey: input.idempotencyKey ?? `fork-${id}-${input.fromMessageId}-${Date.now()}`,
        conversationHistory: history,
      },
      correlationId,
    );
  }
  audit({
    actor: user.id,
    action: "hermes.session.fork",
    source: "hermes",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { child: child.id, fromMessageId: input.fromMessageId },
  });
  if (input.prompt?.trim() && !run) {
    run = await startRun(user, { sessionId: child.id, input: input.prompt, idempotencyKey: input.idempotencyKey ?? `fork-${child.id}` }, correlationId);
  }
  return { session: decorate([child], user)[0]!, run };
}

export type StartRunRequest = {
  sessionId: string;
  input: string;
  idempotencyKey: string;
  model?: string;
  provider?: string;
  conversationHistory?: { role: string; content: string }[];
};

export async function startRun(user: CurrentUser, r: StartRunRequest, correlationId: string): Promise<RunView> {
  assertSessionId(r.sessionId);
  assertAccess(user, r.sessionId, "write");
  if (!/^[\x21-\x7e]{1,255}$/.test(r.idempotencyKey)) throw new HttpError(400, "bad_idempotency_key", "Invalid idempotency key");
  const existing = db().select().from(schema.runs).where(eq(schema.runs.idempotencyKey, r.idempotencyKey)).get();
  if (existing) {
    return { runId: existing.runId, sessionId: existing.sessionId, status: existing.status as RunView["status"] };
  }
  const res = await HermesExecutionClient.start(hermesConn(), r);
  db()
    .insert(schema.runs)
    .values({
      runId: res.run_id,
      sessionId: r.sessionId,
      userId: user.id,
      idempotencyKey: r.idempotencyKey,
      status: "running",
      inputPreview: r.input.slice(0, 140),
    })
    .onConflictDoNothing()
    .run();
  touchMeta(user, r.sessionId, { lastSeenAt: new Date().toISOString() });
  audit({
    actor: user.id,
    action: "hermes.run.start",
    source: "hermes",
    sourceRecord: r.sessionId,
    result: "ok",
    correlationId,
    detail: { runId: res.run_id },
  });
  return { runId: res.run_id, sessionId: r.sessionId, status: "running" };
}

function updateRunRow(runId: string, patch: Partial<typeof schema.runs.$inferInsert>) {
  db()
    .update(schema.runs)
    .set({ ...patch, lastCheckedAt: new Date().toISOString() })
    .where(eq(schema.runs.runId, runId))
    .run();
}

/** Authoritative state from Hermes. Never infer completion from a closed stream. */
export async function reconcileRun(runId: string): Promise<RunView> {
  const row = db().select().from(schema.runs).where(eq(schema.runs.runId, runId)).get();
  try {
    const s = await HermesExecutionClient.status(hermesConn(), runId);
    const approval = s.status === "waiting_for_approval" ? normalizeApproval(s.approval ?? undefined) : undefined;
    const terminal = isTerminal(s.status);
    updateRunRow(runId, {
      status: s.status,
      pendingApproval: approval ? JSON.stringify(approval) : null,
      ...(terminal && !row?.completedAt ? { completedAt: new Date().toISOString() } : {}),
    });
    return {
      runId,
      sessionId: s.session_id ?? row?.sessionId ?? "",
      status: s.status as RunView["status"],
      output: s.output ?? undefined,
      error: s.error ?? undefined,
      pendingSteer: s.pending_steer ?? undefined,
      pendingApproval: approval,
    };
  } catch (err) {
    if (err instanceof UpstreamError && err.kind === "not_found" && row) {
      // Hermes forgets terminal runs after ~1h (24h with idempotency). If we never
      // saw a terminal state, report it as interrupted rather than completed.
      const status = isTerminal(row.status) ? row.status : "interrupted";
      updateRunRow(runId, { status, completedAt: row.completedAt ?? new Date().toISOString() });
      return { runId, sessionId: row.sessionId, status: status as RunView["status"] };
    }
    throw err;
  }
}

export async function getRun(user: CurrentUser, runId: string) {
  assertRunOwner(user, runId);
  return reconcileRun(runId);
}

export async function stopRun(user: CurrentUser, runId: string, correlationId: string): Promise<RunView> {
  const row = assertRunOwner(user, runId);
  const res = await HermesExecutionClient.stop(hermesConn(), runId);
  // Remain "stopping" until Hermes confirms a terminal state.
  const status = isTerminal(res.status) ? res.status : "stopping";
  updateRunRow(runId, { status });
  audit({ actor: user.id, action: "hermes.run.stop", source: "hermes", sourceRecord: runId, result: "ok", correlationId });
  return { runId, sessionId: row.sessionId, status: status as RunView["status"] };
}

export async function respondApproval(
  user: CurrentUser,
  runId: string,
  body: { choice: "once" | "session" | "always" | "deny"; requestId?: string },
  correlationId: string,
) {
  assertRunOwner(user, runId);
  try {
    const res = await HermesExecutionClient.approve(hermesConn(), runId, { choice: body.choice, request_id: body.requestId });
    updateRunRow(runId, { pendingApproval: null, status: "running" });
    audit({ actor: user.id, action: "hermes.approval", source: "hermes", sourceRecord: runId, result: "ok", correlationId, detail: body });
    return res;
  } catch (err) {
    audit({
      actor: user.id,
      action: "hermes.approval",
      source: "hermes",
      sourceRecord: runId,
      result: "error",
      correlationId,
      detail: { ...body, error: (err as Error).message },
    });
    throw err;
  }
}

export async function steerRun(user: CurrentUser, runId: string, input: string, correlationId: string) {
  assertRunOwner(user, runId);
  const res = await HermesExecutionClient.steer(hermesConn(), runId, input);
  audit({ actor: user.id, action: "hermes.steer", source: "hermes", sourceRecord: runId, result: "ok", correlationId });
  return res;
}

// --- SSE relay ---

const streams = processSingleton("hermes_streams", () => ({ active: 0 }));

/**
 * Relay /v1/runs/:id/events through the BFF as normalized Jarvis events.
 * The upstream key never reaches the browser. When the upstream stream ends
 * without a terminal event we emit `stream.closed` so the client reconciles.
 */
export function relayRunEvents(user: CurrentUser, runId: string, lastSeq: string | undefined, clientSignal: AbortSignal) {
  assertRunOwner(user, runId);
  if (streams.active >= config.maxStreams) throw new HttpError(429, "too_many_streams", "Too many open streams");
  streams.active++;
  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort();
  clientSignal.addEventListener("abort", onClientAbort);
  const encoder = new TextEncoder();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    streams.active--;
    clientSignal.removeEventListener("abort", onClientAbort);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // If the browser is gone, stop relaying and free the slot even if the abort signal never fires.
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          upstreamAbort.abort();
          release();
          return false;
        }
      };
      const send = (e: RunEvent, id?: number) => write(formatSse(e, id !== undefined ? { id } : {}));
      write(": relay open\n\nretry: 2000\n\n");
      const keepalive = setInterval(() => write(": keepalive\n\n"), 15_000);
      let sawTerminal = false;
      try {
        const res = await HermesExecutionClient.events(hermesConn(), runId, lastSeq, upstreamAbort.signal);
        if (!res.body) throw new UpstreamError("Hermes", "bad_response", "Hermes returned an empty event stream");
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SseParser();
        for (;;) {
          const { value, done } = await reader.read();
          const frames = done ? parser.end() : parser.push(value);
          for (const f of frames) {
            let raw: unknown;
            try {
              raw = JSON.parse(f.data);
            } catch {
              continue;
            }
            const parsed = runEventSchema.safeParse(raw);
            if (!parsed.success) continue;
            const ev = normalizeRunEvent(parsed.data as never);
            if (ev.type === "approval.requested") {
              updateRunRow(runId, {
                status: "waiting_for_approval",
                pendingApproval: JSON.stringify({ requestId: ev.requestId, command: ev.command, description: ev.description, choices: ev.choices }),
              });
            } else if (ev.type === "approval.resolved") {
              updateRunRow(runId, { status: "running", pendingApproval: null });
            } else if (ev.type === "run.terminal") {
              sawTerminal = true;
              // The user watched it finish live, so no "background work completed" alert is needed.
              updateRunRow(runId, {
                status: ev.status,
                pendingApproval: null,
                completedAt: new Date().toISOString(),
                notifiedCompletion: !clientSignal.aborted,
              });
            }
            send(ev, parsed.data.seq ?? (f.id !== undefined ? Number(f.id) : undefined));
          }
          if (done) break;
        }
        if (!sawTerminal) send({ type: "stream.closed", reason: "upstream_closed" });
      } catch (err) {
        if (!clientSignal.aborted) {
          send({ type: "stream.closed", reason: "error", message: (err as Error).message });
        }
      } finally {
        clearInterval(keepalive);
        release();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      upstreamAbort.abort();
      release();
    },
  });
}

/** Runs that still need reconciliation (used by the background worker). */
export function unfinishedRuns() {
  return db()
    .select()
    .from(schema.runs)
    .where(notInArray(schema.runs.status, [...RUN_TERMINAL]))
    .all();
}

export function runsNeedingCompletionNotice() {
  return db()
    .select()
    .from(schema.runs)
    .where(and(inArray(schema.runs.status, [...RUN_TERMINAL]), eq(schema.runs.notifiedCompletion, false)))
    .all();
}

export function markCompletionNotified(runId: string) {
  updateRunRow(runId, { notifiedCompletion: true });
}
