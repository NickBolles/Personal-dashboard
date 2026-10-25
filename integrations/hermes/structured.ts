import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { UpstreamError } from "@/server/http/errors";
import { getSetting, setSetting } from "@/server/settings";
import { processSingleton } from "@/server/singleton";
import { HermesExecutionClient, HermesSessionClient, hermesConn } from "./client";
import { RUN_TERMINAL } from "./types";
import { extractJson, parseStructured, sleep, within } from "./jobs";

/**
 * Structured requests: some sources (Skylight, Daily Compass) are owned by
 * Hermes tools rather than reachable by Jarvis directly. Jarvis asks Hermes
 * for a JSON answer in a throwaway hidden session, validates it with zod, and
 * fails closed on anything else. Nothing is reported as done unless the
 * answer itself says so after Hermes read it back.
 */
export const STRUCTURED_MARKER = "JARVIS_STRUCTURED_REQUEST";
export const SYNC_SESSION_SOURCE = "jarvis-sync";

export type StructuredRequest<T> = {
  /** source key, e.g. "skylight" — used for the marker, session title and error labels */
  source: string;
  label: string;
  task: string;
  schema: z.ZodType<T>;
  example: unknown;
  timeoutMs?: number;
};

const pollMs = () => Number(process.env.JARVIS_STRUCTURED_POLL_MS ?? 750);

export function structuredInstructions(source: string, example: unknown) {
  return [
    `${STRUCTURED_MARKER} source=${source}`,
    "This is an automated request from the Jarvis dashboard, not a person.",
    "Use your tools to do exactly the task below. Do not ask questions and do not take any action the task does not name.",
    "Reply with ONE JSON object and nothing else: no prose, no markdown. It must have this shape:",
    JSON.stringify(example),
    'If you cannot complete the task (tool missing, auth failed, anything uncertain), reply {"error": "<short reason>"} instead. Never guess or invent data.',
  ].join("\n");
}

// JSON extraction/validation and the bounded-call helper are shared with the AI job runner (./jobs.ts).
export { extractJson, parseStructured };

/** Stop is asynchronous. Delete only after a separately observed terminal status. */
export async function runStructured<T>(req: StructuredRequest<T>): Promise<T> {
  const startedAt = Date.now();
  const budget = Math.min(120_000, Math.max(100, req.timeoutMs ?? 120_000));
  const deadline = startedAt + budget;
  // Reserve cleanup INSIDE the existing overall budget, not an added timeout.
  const workDeadline = deadline - Math.min(10_000, budget / 4);
  let sessionId: string | undefined;
  let runId: string | undefined;
  let startAttempted = false;
  let terminal = false;
  let lastStatus = "unknown";
  let failure: UpstreamError["kind"] | undefined;
  let cleanup = "retained";
  const conn = hermesConn();
  const observe = (status: string) => {
    lastStatus = [...RUN_TERMINAL, "queued", "running", "stopping", "waiting_for_approval"].includes(status) ? status : "unknown";
    terminal = (RUN_TERMINAL as readonly string[]).includes(lastStatus);
  };
  try {
    const { session } = await within(workDeadline, (signal) =>
      HermesSessionClient.create(conn, { title: `${SYNC_SESSION_SOURCE}:${req.source}`, source: SYNC_SESSION_SOURCE }, signal),
    );
    sessionId = session.id;
    await within(workDeadline, (signal) => HermesSessionClient.update(conn, session.id, { hidden: true }, signal));
    startAttempted = true;
    const run = await within(workDeadline, (signal) =>
      HermesExecutionClient.start(
        conn,
        {
          sessionId: session.id,
          input: req.task,
          idempotencyKey: crypto.randomUUID(),
          instructions: structuredInstructions(req.source, req.example),
          conversationHistory: [],
        },
        signal,
      ),
    );
    runId = run.run_id;
    while (Date.now() < workDeadline) {
      const status = await within(workDeadline, (signal) => HermesExecutionClient.status(conn, run.run_id, signal));
      observe(status.status);
      if (lastStatus === "completed") return parseStructured(req.label, status.output, req.schema);
      if (terminal) throw new Error("terminal_failure");
      if (lastStatus === "waiting_for_approval") {
        failure = "unsupported";
        throw new Error("approval_required");
      }
      await sleep(Math.min(Math.max(50, pollMs() || 750), workDeadline - Date.now()));
    }
    throw new Error("sync_deadline");
  } catch (error) {
    // Preserve controlled transport classifications, never the upstream message.
    failure ??= error instanceof UpstreamError ? error.kind : Date.now() >= workDeadline ? "timeout" : "bad_response";
    // Never persist provider errors, model text, prompts or schema values.
    throw new UpstreamError(
      req.label,
      failure,
      failure === "timeout"
        ? `Hermes did not finish the ${req.label} request in time`
        : failure === "unauthorized"
          ? `Hermes authentication failed for ${req.label}; check Hermes credentials`
          : failure === "unsupported" && lastStatus === "waiting_for_approval"
            ? `Hermes requested approval for ${req.label}; use chat instead`
            : `Hermes could not complete the ${req.label} request`,
    );
  } finally {
    if (runId && !terminal) {
      const id = runId;
      const waitDeadline = Math.min(deadline - Math.min(2000, budget / 20), Date.now() + 8000);
      await within(Math.min(waitDeadline, Date.now() + 3000), (signal) => HermesExecutionClient.stop(conn, id, signal)).catch(() => undefined);
      while (!terminal && Date.now() < waitDeadline) {
        try {
          observe((await within(waitDeadline, (signal) => HermesExecutionClient.status(conn, id, signal))).status);
        } catch {
          break;
        }
        if (!terminal) await sleep(Math.min(250, waitDeadline - Date.now()));
      }
    }
    // A failed start response may hide an accepted run. No ID means no proof: retain.
    // Hermes can publish cancelled/interrupted when its asyncio handler is cancelled
    // while its executor thread still runs. Those statuses alone cannot prove quiescence.
    const safeTerminal = lastStatus === "completed" || lastStatus === "failed";
    if (sessionId && (safeTerminal || !startAttempted)) {
      const id = sessionId;
      try {
        const result = await within(deadline, (signal) => HermesSessionClient.remove(conn, id, signal));
        cleanup = result.deleted === true ? "deleted" : "unconfirmed";
      } catch {
        cleanup = "unconfirmed";
      }
    }
    if (failure || cleanup !== "deleted") {
      const safeId = (id: string | undefined) => (id && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : undefined);
      const source = req.source === "daily_compass_complete" ? "daily_compass" : ["skylight", "daily_compass"].includes(req.source) ? req.source : "other";
      // One bounded latest record per known source; no transcript or untrusted text.
      setSetting(`hermes_sync_failure:${source}`, {
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        code: failure ?? "cleanup_unconfirmed",
        sessionId: safeId(sessionId),
        runId: safeId(runId),
        status: lastStatus,
        cleanup,
      });
    }
  }
}

/* ---------------------------------------------------------------------------
 * Snapshot cache. Hermes answers take seconds to minutes, far longer than a
 * Home render may wait, so adapters read the last validated answer and
 * refresh it in the background. The answer's own time (asOf) drives the
 * freshness shown in the UI, so old data is labelled stale, never passed off
 * as live.
 * ------------------------------------------------------------------------- */

export type Snapshot<T> = { key: string; data: T; asOf: string };
type SnapshotRecord<T> = { key: string; data?: T; asOf?: string; error?: string; errorAt?: string };

const inflight = processSingleton("hermes_structured_inflight", () => new Map<string, Promise<unknown>>());

const settingKey = (source: string) => `hermes_snapshot:${source}`;

function readRecord<T>(source: string, key: string): SnapshotRecord<T> | undefined {
  const r = getSetting<SnapshotRecord<T>>(settingKey(source));
  return r && r.key === key ? r : undefined;
}

export function saveSnapshot<T>(source: string, key: string, data: T, asOf = new Date().toISOString()) {
  setSetting(settingKey(source), { key, data, asOf } satisfies SnapshotRecord<T>);
}

export function clearSnapshot(source: string) {
  setSetting(settingKey(source), null);
}

/** Refresh once per source+key at a time; concurrent callers share the same promise. */
export function refreshSnapshot<T>(source: string, key: string, load: () => Promise<T>): Promise<Snapshot<T>> {
  const flightKey = `${source}:${key}`;
  const existing = inflight.get(flightKey) as Promise<Snapshot<T>> | undefined;
  if (existing) return existing;
  const startedAt = new Date().toISOString();
  const p = (async () => {
    try {
      const data = await load();
      const asOf = new Date().toISOString();
      // A write that finished meanwhile (e.g. "mark complete" with readback) is newer than this read: keep it.
      const current = readRecord<T>(source, key);
      if (current?.data !== undefined && current.asOf && current.asOf > startedAt) return { key, data: current.data, asOf: current.asOf };
      saveSnapshot(source, key, data, asOf);
      return { key, data, asOf };
    } catch (err) {
      const prev = readRecord<T>(source, key);
      setSetting(settingKey(source), { ...(prev ?? { key }), error: (err as Error).message, errorAt: new Date().toISOString() });
      throw err;
    } finally {
      inflight.delete(flightKey);
    }
  })();
  inflight.set(flightKey, p);
  return p;
}

/**
 * Return the cached answer for `key`, refreshing in the background when it is
 * older than `maxAgeMs`. With no answer yet, wait briefly for the first one,
 * then report honestly that the first sync is still running. After a failed
 * sync, wait `retryMs` before asking Hermes again (each ask is a model run).
 */
export async function cachedStructured<T>(opts: {
  source: string;
  label: string;
  key: string;
  maxAgeMs: number;
  waitMs?: number;
  retryMs?: number;
  load: () => Promise<T>;
}): Promise<Snapshot<T>> {
  const rec = readRecord<T>(opts.source, opts.key);
  const fresh = rec?.asOf && Date.now() - new Date(rec.asOf).getTime() < opts.maxAgeMs;
  if (rec?.data !== undefined && rec.asOf && fresh) return { key: opts.key, data: rec.data, asOf: rec.asOf };

  const retryMs = opts.retryMs ?? Math.min(opts.maxAgeMs, 5 * 60_000);
  const backingOff = rec?.errorAt && (!rec.asOf || rec.errorAt > rec.asOf) && Date.now() - new Date(rec.errorAt).getTime() < retryMs;
  if (backingOff && !inflight.has(`${opts.source}:${opts.key}`)) {
    if (rec.data !== undefined && rec.asOf) return { key: opts.key, data: rec.data, asOf: rec.asOf };
    throw new UpstreamError(opts.label, "bad_response", rec.error ?? `${opts.label} sync via Hermes failed`);
  }

  const pending = refreshSnapshot(opts.source, opts.key, opts.load);
  if (rec?.data !== undefined && rec.asOf) {
    pending.catch(() => undefined);
    return { key: opts.key, data: rec.data, asOf: rec.asOf };
  }
  const waitMs = opts.waitMs ?? 4000;
  const first = await Promise.race([pending.catch((e: Error) => e), sleep(waitMs).then(() => "pending" as const)]);
  if (first === "pending") {
    pending.catch(() => undefined);
    throw new UpstreamError(opts.label, "timeout", `First sync via Hermes is still running${rec?.error ? ` (last attempt: ${rec.error})` : ""}`);
  }
  if (first instanceof Error) throw first;
  return first;
}
