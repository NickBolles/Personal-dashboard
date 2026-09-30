import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { UpstreamError } from "@/server/http/errors";
import { getSetting, setSetting } from "@/server/settings";
import { processSingleton } from "@/server/singleton";
import { HermesExecutionClient, HermesSessionClient, hermesConn } from "./client";
import { RUN_TERMINAL } from "./types";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one structured request end to end. Always cleans up its session. */
export async function runStructured<T>(req: StructuredRequest<T>): Promise<T> {
  const conn = hermesConn();
  const deadline = Date.now() + (req.timeoutMs ?? 120_000);
  const { session } = await HermesSessionClient.create(conn, { title: `${SYNC_SESSION_SOURCE}:${req.source}`, source: SYNC_SESSION_SOURCE });
  try {
    await HermesSessionClient.update(conn, session.id, { hidden: true }).catch(() => undefined);
    const run = await HermesExecutionClient.start(conn, {
      sessionId: session.id,
      input: req.task,
      idempotencyKey: crypto.randomUUID(),
      instructions: structuredInstructions(req.source, req.example),
      conversationHistory: [],
    });
    for (;;) {
      const status = await HermesExecutionClient.status(conn, run.run_id);
      if (status.status === "completed") return parseStructured(req.label, status.output, req.schema);
      if ((RUN_TERMINAL as readonly string[]).includes(status.status)) {
        throw new UpstreamError(req.label, "bad_response", `Hermes ${status.status} the ${req.label} request${status.error ? `: ${status.error}` : ""}`);
      }
      if (status.status === "waiting_for_approval") {
        await HermesExecutionClient.stop(conn, run.run_id).catch(() => undefined);
        throw new UpstreamError(
          req.label,
          "unsupported",
          `Hermes asked for approval during the ${req.label} request, so Jarvis stopped it. Do this one in chat.`,
        );
      }
      if (Date.now() > deadline) {
        await HermesExecutionClient.stop(conn, run.run_id).catch(() => undefined);
        throw new UpstreamError(req.label, "timeout", `Hermes did not finish the ${req.label} request in time`);
      }
      await sleep(pollMs());
    }
  } finally {
    await HermesSessionClient.remove(conn, session.id).catch(() => undefined);
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
