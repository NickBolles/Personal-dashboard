import "server-only";
import { z } from "zod";
import { UpstreamError } from "@/server/http/errors";
import { HermesExecutionClient, HermesSessionClient, hermesConn, type HermesConn } from "./client";
import { RUN_TERMINAL } from "./types";

/**
 * Generalised Hermes background run (phase 5 AI jobs; also the helpers behind
 * structured.ts): create a session (hidden or visible), start one run with a
 * stable Idempotency-Key, poll to a terminal status, stop on abort/deadline and
 * wait for Hermes to confirm, validate the JSON answer with zod (one repair
 * turn), read the session's cost, and delete hidden sessions only after a safe
 * terminal. Never returns or records provider error text, prompts or output
 * except the validated data.
 */

/** Pull the first JSON object out of a reply, tolerating code fences or stray prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("no JSON object in reply");
  }
}

const errorAnswer = z.object({ error: z.string().min(1) });

export function parseStructured<T>(label: string, output: string | null | undefined, schema: z.ZodType<T>): T {
  if (!output?.trim()) throw new UpstreamError(label, "bad_response", `Hermes returned no answer for ${label}`);
  let raw: unknown;
  try {
    raw = extractJson(output);
  } catch {
    throw new UpstreamError(label, "bad_response", `Hermes did not answer ${label} with JSON`);
  }
  const err = errorAnswer.safeParse(raw);
  if (err.success) throw new UpstreamError(label, "bad_response", `Hermes could not complete ${label}: ${err.data.error.slice(0, 200)}`);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UpstreamError(
      label,
      "bad_response",
      `Hermes answer for ${label} didn't match the contract (${issue?.path.join(".") || "root"}: ${issue?.message})`,
    );
  }
  return parsed.data;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Bound transport AND awaiting it; abort is not confirmation that Hermes stopped. */
export async function within<T>(deadline: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("sync_deadline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("sync_deadline"));
    }, remaining);
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export type TaskErrorCode = "timeout" | "approval_required" | "bad_output" | "upstream" | "cost_cap" | "hermes_unavailable" | "cancelled";

export class HermesTaskError extends Error {
  constructor(
    public code: TaskErrorCode,
    message: string,
    public ids: { sessionId?: string; runId?: string; terminalObserved: boolean },
  ) {
    super(message);
  }
}

export type TaskCost = { costUsd: number | null; source: "hermes_actual" | "hermes_estimate" | null; inputTokens: number | null; outputTokens: number | null };

export type HermesTaskInput<T> = {
  label: string;
  visible: boolean;
  title: string;
  /** null/undefined = the Hermes profile default */
  model?: string | null;
  /** sent with `model` (e.g. openai-codex); null = the profile's provider */
  provider?: string | null;
  /** Hermes `model_options` (reasoning effort) */
  modelOptions?: Record<string, unknown> | null;
  conn?: HermesConn;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  idempotencyKey: string;
  timeoutMs: number;
  /** runner cancel */
  signal?: AbortSignal;
  /** adopt an existing session/run after a restart (never start a second run) */
  adopt?: { sessionId: string; runId?: string | null };
  /** persist ids immediately (restart-safe) */
  onIds?: (ids: { sessionId: string; runId?: string }) => void;
  /** every poll: lease renewal; return "stop" to stop at the cost cap */
  onPoll?: (p: { status: string; sessionId: string; runId: string }) => Promise<"continue" | "stop"> | "continue" | "stop";
  /** visible runs that ask for approval: notify once, keep waiting up to the deadline */
  onApproval?: (p: { sessionId: string; runId: string; command?: string }) => void;
  pollMs?: number;
};

export type HermesTaskResult<T> = { data: T; sessionId: string; runId: string; cost: TaskCost };

const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,160}$/;

export async function readCost(conn: HermesConn, sessionId: string): Promise<TaskCost> {
  try {
    const { session } = await within(Date.now() + 6000, () => HermesSessionClient.get(conn, sessionId));
    const raw = session as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const actual = num(raw.actual_cost_usd);
    const est = num(session.estimated_cost_usd);
    return {
      costUsd: actual ?? est,
      source: actual != null ? "hermes_actual" : est != null ? "hermes_estimate" : null,
      inputTokens: num(raw.input_tokens),
      outputTokens: num(raw.output_tokens),
    };
  } catch {
    return { costUsd: null, source: null, inputTokens: null, outputTokens: null };
  }
}

export async function runHermesTask<T>(t: HermesTaskInput<T>): Promise<HermesTaskResult<T>> {
  const conn = t.conn ?? hermesConn();
  const deadline = Date.now() + Math.max(100, t.timeoutMs);
  const pollMs = t.pollMs ?? Number(process.env.JARVIS_AI_POLL_MS ?? (t.visible ? 1500 : 750));
  let sessionId = t.adopt?.sessionId;
  let runId = t.adopt?.runId ?? undefined;
  let status = "unknown";
  let terminal = false;
  let approvalNotified = false;
  const observe = (s: string) => {
    status = s;
    terminal = (RUN_TERMINAL as readonly string[]).includes(s);
  };
  const fail = (code: TaskErrorCode, msg: string) => new HermesTaskError(code, msg, { sessionId, runId, terminalObserved: terminal });

  const stopAndWait = async () => {
    if (!runId || terminal) return;
    const id = runId;
    const waitUntil = Date.now() + 8000;
    await within(Date.now() + 3000, (signal) => HermesExecutionClient.stop(conn, id, signal)).catch(() => undefined);
    while (!terminal && Date.now() < waitUntil) {
      try {
        observe((await within(waitUntil, (signal) => HermesExecutionClient.status(conn, id, signal))).status);
      } catch {
        break;
      }
      if (!terminal) await sleep(Math.min(250, waitUntil - Date.now()));
    }
  };

  const pollToTerminal = async (id: string, until: number, allowApproval: boolean): Promise<string | null | undefined> => {
    let lastCostCheck = 0;
    while (true) {
      if (t.signal?.aborted) {
        await stopAndWait();
        throw fail("cancelled", "Cancelled");
      }
      if (Date.now() >= until) {
        await stopAndWait();
        throw fail("timeout", `Hermes didn't finish ${t.label} in time`);
      }
      const st = await within(until, (signal) => HermesExecutionClient.status(conn, id, signal)).catch((e) => {
        if (e instanceof UpstreamError && e.kind === "unauthorized") throw fail("hermes_unavailable", "Hermes authentication failed");
        return null;
      });
      if (st) {
        observe(st.status);
        if (status === "completed") return st.output;
        if (terminal) throw fail("upstream", `Hermes run ${status}`);
        if (status === "waiting_for_approval") {
          if (!allowApproval) {
            await stopAndWait();
            throw fail("approval_required", "Hermes asked for approval");
          }
          if (!approvalNotified && t.onApproval) {
            approvalNotified = true;
            const approval = (st as Record<string, unknown>).approval as { command?: string } | undefined;
            t.onApproval({ sessionId: sessionId!, runId: id, command: typeof approval?.command === "string" ? approval.command.slice(0, 120) : undefined });
          }
        }
        if (t.onPoll && Date.now() - lastCostCheck >= 0) {
          lastCostCheck = Date.now();
          const verdict = await t.onPoll({ status, sessionId: sessionId!, runId: id });
          if (verdict === "stop") {
            await stopAndWait();
            throw fail("cost_cap", "Stopped at the per-job cost cap");
          }
        }
      }
      await sleep(Math.min(pollMs, until - Date.now()));
    }
  };

  let result: HermesTaskResult<T> | undefined;
  try {
    if (!sessionId) {
      const { session } = await within(deadline, (signal) =>
        HermesSessionClient.create(
          conn,
          {
            title: t.title.slice(0, 120),
            source: t.visible ? "jarvis-ai" : "jarvis-sync",
            ...(t.model ? { model: t.model } : {}),
            ...(t.model && t.provider ? { provider: t.provider } : {}),
          },
          signal,
        ),
      ).catch((e) => {
        throw fail(
          e instanceof UpstreamError && (e.kind === "unreachable" || e.kind === "unauthorized" || e.kind === "unsupported") ? "hermes_unavailable" : "upstream",
          "Hermes session couldn't be created",
        );
      });
      sessionId = SAFE_ID.test(session.id) ? session.id : undefined;
      if (!sessionId) throw fail("upstream", "Hermes returned an unusable session id");
      t.onIds?.({ sessionId });
      if (!t.visible) await within(deadline, (signal) => HermesSessionClient.update(conn, sessionId!, { hidden: true }, signal)).catch(() => undefined);
    }
    if (!runId) {
      const run = await within(deadline, (signal) =>
        HermesExecutionClient.start(
          conn,
          {
            sessionId: sessionId!,
            input: t.input,
            instructions: t.instructions,
            idempotencyKey: t.idempotencyKey,
            ...(t.model ? { model: t.model } : {}),
            ...(t.model && t.provider ? { provider: t.provider } : {}),
            ...(t.modelOptions ? { modelOptions: t.modelOptions } : {}),
            conversationHistory: [],
          },
          signal,
        ),
      ).catch((e) => {
        throw fail(
          e instanceof UpstreamError && (e.kind === "unreachable" || e.kind === "unauthorized") ? "hermes_unavailable" : "upstream",
          "Hermes didn't start the run",
        );
      });
      runId = run.run_id;
      t.onIds?.({ sessionId: sessionId!, runId });
    }
    const output = await pollToTerminal(runId, deadline, t.visible);
    let data: T;
    try {
      data = parseStructured(t.label, output, t.schema);
    } catch (e) {
      const declined = e instanceof UpstreamError && /could not complete/.test(e.message);
      if (declined) throw fail("bad_output", "Hermes couldn't complete it");
      // One repair turn in the same session, then give up (the visible conversation keeps the prose).
      const repair = await within(deadline, (signal) =>
        HermesExecutionClient.start(
          conn,
          {
            sessionId: sessionId!,
            input: "Reply again with only the JSON object described in your instructions. No prose.",
            instructions: t.instructions,
            idempotencyKey: `${t.idempotencyKey}:repair`,
            conversationHistory: [],
          },
          signal,
        ),
      ).catch(() => null);
      if (!repair) throw fail("bad_output", "Hermes didn't answer with valid JSON");
      runId = repair.run_id;
      terminal = false;
      t.onIds?.({ sessionId: sessionId!, runId });
      const again = await pollToTerminal(repair.run_id, deadline, false);
      try {
        data = parseStructured(t.label, again, t.schema);
      } catch {
        throw fail("bad_output", "Hermes didn't answer with valid JSON");
      }
    }
    result = { data, sessionId: sessionId!, runId, cost: { costUsd: null, source: null, inputTokens: null, outputTokens: null } };
  } catch (e) {
    if (e instanceof HermesTaskError) throw e;
    await stopAndWait().catch(() => undefined);
    throw fail(Date.now() >= deadline ? "timeout" : "upstream", Date.now() >= deadline ? `Hermes didn't finish ${t.label} in time` : "Hermes run failed");
  } finally {
    // Hidden sessions: delete only after a safe terminal (same rule as structured.ts).
    if (sessionId && !t.visible && (status === "completed" || status === "failed")) {
      const cost = await readCost(conn, sessionId);
      if (result) result.cost = cost;
      else lastCost.set(t.idempotencyKey, cost);
      await within(Date.now() + 6000, (signal) => HermesSessionClient.remove(conn, sessionId!, signal)).catch(() => undefined);
    } else if (sessionId && t.visible && !result) {
      // Failed/cancelled visible runs are charged what Hermes reports, not just the estimate.
      lastCost.set(t.idempotencyKey, await readCost(conn, sessionId));
    }
  }
  if (t.visible) result.cost = await readCost(conn, result.sessionId);
  return result;
}

/** Cost of a run that failed (hidden: read before deletion; visible: read at the failure), keyed by idempotency key. */
const lastCost = new Map<string, TaskCost>();
export function takeLastCost(key: string) {
  const c = lastCost.get(key);
  lastCost.delete(key);
  return c;
}
