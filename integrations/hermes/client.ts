import "server-only";
import { z } from "zod";
import { UpstreamError } from "@/server/http/errors";
import { upstream, type UpstreamRequest } from "@/server/http/fetch";
import { resolveIntegration } from "@/integrations/store";
import {
  capabilitiesSchema,
  healthSchema,
  jobSchema,
  listSchema,
  messageListSchema,
  modelSchema,
  runCreatedSchema,
  runStatusSchema,
  sessionEnvelopeSchema,
  sessionListSchema,
  skillSchema,
  toolsetSchema,
} from "./types";

export type HermesConn = { baseUrl: string; apiKey?: string };

export function hermesConn(): HermesConn {
  const r = resolveIntegration("hermes");
  if (!r.config.baseUrl) throw new UpstreamError("Hermes", "unsupported", "Hermes is not configured yet");
  return { baseUrl: r.config.baseUrl, apiKey: r.secrets.apiKey };
}

function call<T>(conn: HermesConn, req: Omit<UpstreamRequest, "source" | "baseUrl">, schema?: z.ZodType<T>) {
  return upstream<unknown>({
    source: "Hermes",
    baseUrl: conn.baseUrl,
    ...req,
    headers: { ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}), ...req.headers },
  }).then((data) => {
    if (!schema || req.raw) return data as T;
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new UpstreamError("Hermes", "bad_response", `Unexpected Hermes response for ${req.path}: ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
  });
}

/** Capabilities, health, models, skills, toolsets. */
export const HermesDiscoveryClient = {
  health: (c: HermesConn) => call(c, { path: "/health", timeoutMs: 4000 }, healthSchema),
  capabilities: (c: HermesConn) => call(c, { path: "/v1/capabilities", timeoutMs: 5000 }, capabilitiesSchema),
  models: (c: HermesConn) => call(c, { path: "/v1/models" }, listSchema(modelSchema)),
  modelOptions: (c: HermesConn) =>
    call(
      c,
      { path: "/api/model/options" },
      z.object({ providers: z.array(z.unknown()).default([]), model: z.string().nullish(), provider: z.string().nullish() }).passthrough(),
    ),
  skills: (c: HermesConn) => call(c, { path: "/v1/skills" }, listSchema(skillSchema)),
  toolsets: (c: HermesConn) => call(c, { path: "/v1/toolsets" }, listSchema(toolsetSchema)),
};

/** Sessions, messages, fork, metadata. */
export const HermesSessionClient = {
  list: (c: HermesConn, q: { limit?: number; offset?: number; includeChildren?: boolean } = {}) =>
    call(c, { path: "/api/sessions", query: { limit: q.limit ?? 50, offset: q.offset ?? 0, include_children: q.includeChildren ?? true } }, sessionListSchema),
  get: (c: HermesConn, id: string) => call(c, { path: `/api/sessions/${encodeURIComponent(id)}` }, sessionEnvelopeSchema),
  create: (c: HermesConn, body: { title?: string; source?: string; model?: string; provider?: string }) =>
    call(c, { path: "/api/sessions", method: "POST", body }, sessionEnvelopeSchema),
  update: (c: HermesConn, id: string, body: { title?: string | null; archived?: boolean; pinned?: boolean; hidden?: boolean; unread?: boolean }) =>
    call(c, { path: `/api/sessions/${encodeURIComponent(id)}`, method: "PATCH", body }, sessionEnvelopeSchema),
  remove: (c: HermesConn, id: string) =>
    call(c, { path: `/api/sessions/${encodeURIComponent(id)}`, method: "DELETE" }, z.object({ deleted: z.boolean().optional() }).passthrough()),
  messages: (c: HermesConn, id: string, q: { limit?: number; offset?: number; order?: "oldest" | "latest"; includeCompacted?: boolean } = {}) =>
    call(
      c,
      {
        path: `/api/sessions/${encodeURIComponent(id)}/messages`,
        query: {
          limit: q.limit ?? 500,
          offset: q.offset ?? 0,
          order: q.order ?? "latest",
          ...(q.includeCompacted !== undefined ? { include_compacted: q.includeCompacted } : {}),
        },
      },
      messageListSchema,
    ),
  fork: (c: HermesConn, id: string, body: { title?: string }) =>
    call(c, { path: `/api/sessions/${encodeURIComponent(id)}/fork`, method: "POST", body }, sessionEnvelopeSchema),
};

export type StartRunInput = {
  sessionId: string;
  input: string;
  idempotencyKey: string;
  model?: string;
  provider?: string;
  instructions?: string;
  conversationHistory?: { role: string; content: string }[];
};

/** Runs, SSE, approvals, steering, stop. */
export const HermesExecutionClient = {
  start: (c: HermesConn, r: StartRunInput) =>
    call(
      c,
      {
        path: "/v1/runs",
        method: "POST",
        headers: { "idempotency-key": r.idempotencyKey },
        body: {
          input: r.input,
          session_id: r.sessionId,
          ...(r.model ? { model: r.model } : {}),
          ...(r.provider ? { provider: r.provider } : {}),
          ...(r.instructions ? { instructions: r.instructions } : {}),
          ...(r.conversationHistory ? { conversation_history: r.conversationHistory } : {}),
        },
        timeoutMs: 15_000,
      },
      runCreatedSchema,
    ),
  status: (c: HermesConn, runId: string) => call(c, { path: `/v1/runs/${encodeURIComponent(runId)}`, timeoutMs: 6000 }, runStatusSchema),
  /** Opens the upstream SSE stream. Caller owns the response body. */
  events: (c: HermesConn, runId: string, lastSeq: string | undefined, signal: AbortSignal) =>
    call<Response>(c, {
      path: `/v1/runs/${encodeURIComponent(runId)}/events`,
      headers: lastSeq !== undefined ? { "last-event-id": lastSeq } : {},
      raw: true,
      signal,
      timeoutMs: 24 * 60 * 60 * 1000,
    }),
  stop: (c: HermesConn, runId: string) =>
    call(
      c,
      { path: `/v1/runs/${encodeURIComponent(runId)}/stop`, method: "POST" },
      z.object({ run_id: z.string().optional(), status: z.string() }).passthrough(),
    ),
  approve: (c: HermesConn, runId: string, body: { choice: string; request_id?: string }) =>
    call(
      c,
      { path: `/v1/runs/${encodeURIComponent(runId)}/approval`, method: "POST", body },
      z.object({ choice: z.string().optional(), resolved: z.number().optional() }).passthrough(),
    ),
  steer: (c: HermesConn, runId: string, input: string) =>
    call(
      c,
      { path: `/v1/runs/${encodeURIComponent(runId)}/steer`, method: "POST", body: { input } },
      z.object({ accepted: z.boolean().optional() }).passthrough(),
    ),
};

/** Cron jobs. `jobs_admin` capability reads false even when routes exist, so probe. */
export const HermesAutomationClient = {
  list: (c: HermesConn) => call(c, { path: "/api/jobs", query: { include_disabled: true } }, z.object({ jobs: z.array(jobSchema) }).passthrough()),
  pause: (c: HermesConn, id: string) => call(c, { path: `/api/jobs/${id}/pause`, method: "POST" }, z.object({ job: jobSchema }).passthrough()),
  resume: (c: HermesConn, id: string) => call(c, { path: `/api/jobs/${id}/resume`, method: "POST" }, z.object({ job: jobSchema }).passthrough()),
  run: (c: HermesConn, id: string) => call(c, { path: `/api/jobs/${id}/run`, method: "POST", body: {} }, z.object({ job: jobSchema }).passthrough()),
};
