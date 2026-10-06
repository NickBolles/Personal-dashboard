import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { processSingleton } from "@/server/singleton";
import { getPreferences } from "@/server/settings";
import { formatSse } from "@/lib/sse";
import { isTerminal, type RunEvent, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { CLAUDE_MODELS } from "@/lib/assistant";
import type { CurrentUser } from "@/server/auth";
import { claudeAvailable, claudeConfig } from "./settings";

/**
 * Conversations answered directly by Claude (the fast option when Hermes is
 * slow). Same shapes as Hermes so the web and phone chat UIs work unchanged:
 * SessionSummary, TimelineItem, RunView and the normalized SSE RunEvents.
 * No tools: Claude can't act here, only answer (with any Jarvis context the
 * person attaches).
 */
const db = () => getDb();

type LiveRun = {
  runId: string;
  sessionId: string;
  events: (RunEvent & { seq: number })[];
  listeners: Set<() => void>;
  abort: AbortController;
  done: boolean;
};
const live = processSingleton("assistant_local_runs", () => new Map<string, LiveRun>());

const SYSTEM = `You are Jarvis, a household assistant inside a private family dashboard. Answer clearly and briefly; use short paragraphs or lists when they help.
You can't take actions, see devices or read accounts yourself. When the message includes a "Context from Jarvis" section, treat it as current facts from the household's own systems and say how fresh it is when that matters. If something isn't in the context, say you don't know rather than guessing.`;

function client() {
  const c = claudeConfig();
  return new Anthropic({
    ...(c.apiKey ? { apiKey: c.apiKey } : {}),
    ...(process.env.JARVIS_ANTHROPIC_BASE_URL ? { baseURL: process.env.JARVIS_ANTHROPIC_BASE_URL } : {}),
    maxRetries: 2,
  });
}

/* ---------------------------------------------------------------- access */

function meta(id: string) {
  return db().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, id)).get();
}

function access(user: CurrentUser, id: string): "write" | "read" | null {
  const m = meta(id);
  if (!m) return null;
  if (m.userId === user.id) return "write";
  return m.shared ? "read" : null;
}

function assertAccess(user: CurrentUser, id: string, need: "read" | "write") {
  const a = access(user, id);
  if (!a || !db().select().from(schema.aiSessions).where(eq(schema.aiSessions.id, id)).get())
    throw new HttpError(404, "session_not_found", "Conversation not found");
  if (need === "write" && a !== "write") throw new HttpError(403, "read_only", "This conversation was shared with you read-only. Fork it to continue.");
}

/* -------------------------------------------------------------- sessions */

function summarize(user: CurrentUser, rows: (typeof schema.aiSessions.$inferSelect)[]): SessionSummary[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const metas = new Map(
    db()
      .select()
      .from(schema.sessionMeta)
      .where(inArray(schema.sessionMeta.sessionId, ids))
      .all()
      .map((m) => [m.sessionId, m]),
  );
  const msgs = db().select().from(schema.aiMessages).where(inArray(schema.aiMessages.sessionId, ids)).orderBy(asc(schema.aiMessages.createdAt)).all();
  const active = db()
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.sessionId, ids))
    .all()
    .filter((r) => !isTerminal(r.status));
  return rows.map((r) => {
    const m = metas.get(r.id);
    const mine = msgs.filter((x) => x.sessionId === r.id);
    const run = active.find((x) => x.sessionId === r.id);
    return {
      id: r.id,
      title: m?.titleOverride ?? r.title,
      preview: mine.at(-1)?.content.slice(0, 140),
      startedAt: r.createdAt,
      lastActiveAt: r.updatedAt,
      messageCount: mine.length,
      pinned: Boolean(m?.pinned),
      archived: Boolean(m?.archived),
      shared: Boolean(m?.shared),
      readOnly: m ? m.userId !== user.id : false,
      source: "claude",
      model: CLAUDE_MODELS.find((x) => x.id === r.model)?.label ?? r.model,
      forkedFromSessionId: m?.forkedFromSessionId ?? undefined,
      forkedFromMessageId: m?.forkedFromMessageId ?? undefined,
      parentSessionId: m?.forkedFromSessionId ?? undefined,
      activeRun: run ? { runId: run.runId, status: run.status } : undefined,
    };
  });
}

export function listLocalSessions(user: CurrentUser, opts: { includeArchived?: boolean } = {}) {
  const visible = db()
    .select({ id: schema.sessionMeta.sessionId })
    .from(schema.sessionMeta)
    .all()
    .map((m) => m.id)
    .filter((id) => id.startsWith("loc_") && access(user, id));
  if (!visible.length) return [];
  const rows = db().select().from(schema.aiSessions).where(inArray(schema.aiSessions.id, visible)).orderBy(desc(schema.aiSessions.updatedAt)).all();
  return summarize(user, rows).filter((s) => opts.includeArchived || !s.archived);
}

export function createLocalSession(user: CurrentUser, title?: string, extra: { forkedFromSessionId?: string; forkedFromMessageId?: string } = {}) {
  if (!claudeAvailable()) throw new HttpError(409, "claude_unavailable", "Claude isn't set up. Add an Anthropic API key in Settings → Assistant.");
  const id = newId("loc");
  db().transaction((tx) => {
    tx.insert(schema.aiSessions)
      .values({ id, backend: "claude", model: claudeConfig().model, title: title?.trim() || "New conversation" })
      .run();
    tx.insert(schema.sessionMeta)
      .values({ sessionId: id, userId: user.id, ...extra })
      .run();
  });
  return summarize(user, [db().select().from(schema.aiSessions).where(eq(schema.aiSessions.id, id)).get()!])[0]!;
}

export function localSessionDetail(user: CurrentUser, id: string) {
  assertAccess(user, id, "read");
  const row = db().select().from(schema.aiSessions).where(eq(schema.aiSessions.id, id)).get()!;
  const [session] = summarize(user, [row]);
  const timeline: TimelineItem[] = db()
    .select()
    .from(schema.aiMessages)
    .where(eq(schema.aiMessages.sessionId, id))
    .orderBy(asc(schema.aiMessages.createdAt))
    .all()
    .map((m) =>
      m.role === "user"
        ? { kind: "user" as const, id: m.id, text: m.content, at: m.createdAt }
        : { kind: "assistant" as const, id: m.id, text: m.content, at: m.createdAt, reasoning: m.reasoning ?? undefined },
    );
  const parentId = session!.forkedFromSessionId;
  const parentRow =
    parentId?.startsWith("loc_") && access(user, parentId) ? db().select().from(schema.aiSessions).where(eq(schema.aiSessions.id, parentId)).get() : undefined;
  const childIds = db()
    .select()
    .from(schema.sessionMeta)
    .where(eq(schema.sessionMeta.forkedFromSessionId, id))
    .all()
    .map((m) => m.sessionId)
    .filter((c) => c.startsWith("loc_") && access(user, c));
  const children = childIds.length ? summarize(user, db().select().from(schema.aiSessions).where(inArray(schema.aiSessions.id, childIds)).all()) : [];
  return { session: session!, timeline, parent: parentRow ? summarize(user, [parentRow])[0] : undefined, children };
}

export function updateLocalSession(
  user: CurrentUser,
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; shared?: boolean },
  correlationId: string,
) {
  assertAccess(user, id, "write");
  const set: Partial<typeof schema.sessionMeta.$inferInsert> = {};
  if (patch.title !== undefined) set.titleOverride = patch.title?.trim() || null;
  if (patch.archived !== undefined) set.archived = patch.archived;
  if (patch.pinned !== undefined) set.pinned = patch.pinned;
  if (patch.shared !== undefined) set.shared = patch.shared;
  if (Object.keys(set).length) db().update(schema.sessionMeta).set(set).where(eq(schema.sessionMeta.sessionId, id)).run();
  audit({ actor: user.id, action: "assistant.session.update", source: "claude", sourceRecord: id, result: "ok", correlationId, detail: patch });
  return localSessionDetail(user, id).session;
}

/** Fork: a new conversation with the transcript up to (and including) a message. */
export async function forkLocalSession(
  user: CurrentUser,
  id: string,
  input: { title?: string; fromMessageId?: string; prompt?: string; idempotencyKey?: string },
  correlationId: string,
) {
  assertAccess(user, id, "read");
  const src = db().select().from(schema.aiSessions).where(eq(schema.aiSessions.id, id)).get()!;
  const msgs = db().select().from(schema.aiMessages).where(eq(schema.aiMessages.sessionId, id)).orderBy(asc(schema.aiMessages.createdAt)).all();
  const cut = input.fromMessageId ? msgs.findIndex((m) => m.id === input.fromMessageId) : msgs.length - 1;
  if (input.fromMessageId && cut === -1) throw new HttpError(404, "message_not_found", "That message is no longer in the conversation");
  const child = createLocalSession(user, input.title?.trim() || `${meta(id)?.titleOverride ?? src.title} (fork)`, {
    forkedFromSessionId: id,
    forkedFromMessageId: input.fromMessageId,
  });
  const base = Date.now();
  msgs.slice(0, cut + 1).forEach((m, i) => {
    db()
      .insert(schema.aiMessages)
      .values({
        id: newId("msg"),
        sessionId: child.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        createdAt: new Date(base - (cut + 1 - i)).toISOString(),
      })
      .run();
  });
  audit({ actor: user.id, action: "assistant.session.fork", source: "claude", sourceRecord: id, result: "ok", correlationId, detail: { child: child.id } });
  const run = input.prompt?.trim()
    ? await startLocalRun(user, { sessionId: child.id, input: input.prompt, idempotencyKey: input.idempotencyKey ?? `fork-${child.id}` }, correlationId)
    : undefined;
  return { session: localSessionDetail(user, child.id).session, run };
}

/* ------------------------------------------------------------------ runs */

function emit(run: LiveRun, e: RunEvent) {
  run.events.push({ ...e, seq: run.events.length + 1 } as RunEvent & { seq: number });
  for (const l of run.listeners) l();
}

function setRun(runId: string, patch: Partial<typeof schema.runs.$inferInsert>) {
  db()
    .update(schema.runs)
    .set({ ...patch, lastCheckedAt: new Date().toISOString() })
    .where(eq(schema.runs.runId, runId))
    .run();
}

function history(sessionId: string): Anthropic.MessageParam[] {
  return db()
    .select()
    .from(schema.aiMessages)
    .where(eq(schema.aiMessages.sessionId, sessionId))
    .orderBy(asc(schema.aiMessages.createdAt))
    .all()
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

function describeError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check it in Settings → Assistant.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (err instanceof Anthropic.NotFoundError) return "That Claude model isn't available to this key.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limiting this key right now. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic.";
  if (err instanceof Anthropic.APIError) return `Claude returned an error (${err.status ?? "?"}).`;
  return `Unexpected error: ${(err as Error).message}`;
}

async function generate(run: LiveRun, model: string) {
  const { effort } = claudeConfig();
  const tz = getPreferences().timezone;
  const today = new Date().toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const messages = history(run.sessionId);
  // A stable system prompt first (cached); today's date as a mid-conversation-friendly suffix block.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Today is ${today} (${tz}).` },
  ];
  let text = "";
  let reasoning = "";
  try {
    // Haiku 4.5 has no adaptive thinking or effort; the current Opus/Sonnet get both,
    // plus server-side refusal fallbacks so a declined request is retried on a fallback model.
    const modern = model !== "claude-haiku-4-5";
    const onEvent = (event: Anthropic.MessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent) => {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          text += event.delta.text;
          emit(run, { type: "text.delta", delta: event.delta.text });
        } else if (event.delta.type === "thinking_delta") {
          reasoning += event.delta.thinking;
          emit(run, { type: "reasoning", text: event.delta.thinking });
        }
      } else if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        const fb = event.content_block;
        emit(run, { type: "commentary", text: `${fb.from.model} declined; ${fb.to.model} answered instead.` });
      }
    };
    let final: { stop_reason: string | null };
    if (modern) {
      const stream = client().beta.messages.stream(
        {
          model,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort },
          system,
          messages,
        },
        { signal: run.abort.signal },
      );
      for await (const event of stream) onEvent(event);
      final = await stream.finalMessage();
    } else {
      const stream = client().messages.stream({ model, max_tokens: 16000, system, messages }, { signal: run.abort.signal });
      for await (const event of stream) onEvent(event);
      final = await stream.finalMessage();
    }
    if (final.stop_reason === "refusal") throw new RefusalError();
    finish(run, "completed", text, reasoning);
  } catch (err) {
    if (run.abort.signal.aborted || err instanceof Anthropic.APIUserAbortError) {
      finish(run, "cancelled", text, reasoning);
    } else if (err instanceof RefusalError) {
      finish(run, "failed", text, reasoning, "Claude declined to answer this.");
    } else {
      if (!(err instanceof Anthropic.APIError)) console.error("[jarvis] claude run failed", err);
      finish(run, "failed", text, reasoning, describeError(err));
    }
  }
}

class RefusalError extends Error {}

function finish(run: LiveRun, status: "completed" | "failed" | "cancelled", text: string, reasoning: string, error?: string) {
  if (run.done) return;
  run.done = true;
  if (text.trim()) {
    db()
      .insert(schema.aiMessages)
      .values({
        id: newId("msg"),
        sessionId: run.sessionId,
        role: "assistant",
        content: status === "cancelled" ? `${text}\n\n_(stopped)_` : text,
        reasoning: reasoning || null,
        runId: run.runId,
      })
      .run();
  }
  db().update(schema.aiSessions).set({ updatedAt: new Date().toISOString() }).where(eq(schema.aiSessions.id, run.sessionId)).run();
  setRun(run.runId, { status, completedAt: new Date().toISOString(), pendingApproval: null });
  emit(run, { type: "run.terminal", status, output: text, error, at: new Date().toISOString() });
  // Keep the event log a while for reconnects, then drop it.
  setTimeout(() => live.delete(run.runId), 10 * 60_000).unref?.();
}

export async function startLocalRun(
  user: CurrentUser,
  r: { sessionId: string; input: string; idempotencyKey: string; model?: string },
  correlationId: string,
): Promise<RunView> {
  assertAccess(user, r.sessionId, "write");
  if (!/^[\x21-\x7e]{1,255}$/.test(r.idempotencyKey)) throw new HttpError(400, "bad_idempotency_key", "Invalid idempotency key");
  const existing = db().select().from(schema.runs).where(eq(schema.runs.idempotencyKey, r.idempotencyKey)).get();
  if (existing) return { runId: existing.runId, sessionId: existing.sessionId, status: existing.status as RunView["status"] };
  const busy = db()
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.sessionId, r.sessionId))
    .all()
    .some((x) => !isTerminal(x.status));
  if (busy) throw new HttpError(409, "run_active", "Claude is still answering. Wait or stop it first.");
  const session = db().select().from(schema.aiSessions).where(eq(schema.aiSessions.id, r.sessionId)).get()!;
  const model = r.model && CLAUDE_MODELS.some((m) => m.id === r.model) ? r.model : session.model;
  const runId = newId("lrn");
  const now = new Date().toISOString();
  db().transaction((tx) => {
    tx.insert(schema.aiMessages)
      .values({ id: newId("msg"), sessionId: r.sessionId, role: "user", content: r.input, runId, createdAt: now })
      .run();
    tx.insert(schema.runs)
      .values({
        runId,
        sessionId: r.sessionId,
        userId: user.id,
        idempotencyKey: r.idempotencyKey,
        status: "running",
        inputPreview: r.input.split("\n\n---\nContext from Jarvis:")[0]!.slice(0, 140),
      })
      .run();
    // First message names the conversation.
    if (session.title === "New conversation")
      tx.update(schema.aiSessions)
        .set({ title: r.input.slice(0, 60) })
        .where(eq(schema.aiSessions.id, r.sessionId))
        .run();
    tx.update(schema.aiSessions).set({ updatedAt: now }).where(eq(schema.aiSessions.id, r.sessionId)).run();
  });
  const run: LiveRun = { runId, sessionId: r.sessionId, events: [], listeners: new Set(), abort: new AbortController(), done: false };
  live.set(runId, run);
  audit({ actor: user.id, action: "assistant.run.start", source: "claude", sourceRecord: r.sessionId, result: "ok", correlationId, detail: { runId, model } });
  void generate(run, model);
  return { runId, sessionId: r.sessionId, status: "running" };
}

function runRow(user: CurrentUser, runId: string) {
  const row = db().select().from(schema.runs).where(eq(schema.runs.runId, runId)).get();
  if (!row || row.userId !== user.id) throw new HttpError(404, "run_not_found", "Run not found");
  return row;
}

/** Authoritative state. A run this server process isn't running anymore (restart) is interrupted, never "completed". */
export function reconcileLocalRun(runId: string): RunView {
  const row = db().select().from(schema.runs).where(eq(schema.runs.runId, runId)).get();
  if (!row) throw new HttpError(404, "run_not_found", "Run not found");
  if (!isTerminal(row.status) && !live.has(runId)) {
    setRun(runId, { status: "interrupted", completedAt: new Date().toISOString() });
    return { runId, sessionId: row.sessionId, status: "interrupted", error: "Jarvis restarted while Claude was answering." };
  }
  const r = live.get(runId);
  const terminal = r?.events.find((e) => e.type === "run.terminal") as Extract<RunEvent, { type: "run.terminal" }> | undefined;
  return { runId, sessionId: row.sessionId, status: (terminal?.status ?? row.status) as RunView["status"], output: terminal?.output, error: terminal?.error };
}

export function getLocalRun(user: CurrentUser, runId: string) {
  runRow(user, runId);
  return reconcileLocalRun(runId);
}

export function stopLocalRun(user: CurrentUser, runId: string, correlationId: string): RunView {
  const row = runRow(user, runId);
  const r = live.get(runId);
  if (r && !r.done) r.abort.abort();
  audit({ actor: user.id, action: "assistant.run.stop", source: "claude", sourceRecord: runId, result: "ok", correlationId });
  return { runId, sessionId: row.sessionId, status: r && !r.done ? "stopping" : (reconcileLocalRun(runId).status as RunView["status"]) };
}

/** SSE in the same normalized format as the Hermes relay; replays from Last-Event-ID. */
export function relayLocalEvents(user: CurrentUser, runId: string, lastSeq: string | undefined, clientSignal: AbortSignal) {
  runRow(user, runId);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      write(": relay open\n\nretry: 2000\n\n");
      const r = live.get(runId);
      if (!r) {
        const v = reconcileLocalRun(runId);
        if (isTerminal(v.status))
          write(formatSse({ type: "run.terminal", status: v.status as "completed", output: v.output, error: v.error, at: new Date().toISOString() }));
        else write(formatSse({ type: "stream.closed", reason: "upstream_closed" }));
        return close();
      }
      let sent = Number(lastSeq ?? 0);
      const flush = () => {
        for (const e of r.events.slice(sent)) {
          write(formatSse(e, { id: e.seq }));
          sent = e.seq;
        }
        if (r.done) cleanup();
      };
      const keepalive = setInterval(() => write(": keepalive\n\n"), 15_000);
      const cleanup = () => {
        clearInterval(keepalive);
        r.listeners.delete(flush);
        clientSignal.removeEventListener("abort", cleanup);
        close();
      };
      clientSignal.addEventListener("abort", cleanup);
      r.listeners.add(flush);
      flush();
    },
  });
}
