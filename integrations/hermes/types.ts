/**
 * Hermes API Server DTOs (pinned: hermes-agent main @ ddd0cc69, tag v2026.9.24).
 * See docs/research/hermes-api.md. Schemas are lenient (passthrough) so new
 * upstream fields never break us, but required fields are enforced.
 */
import { z } from "zod";

export const hermesSessionSchema = z
  .object({
    id: z.string(),
    source: z.string().nullish(),
    model: z.string().nullish(),
    title: z.string().nullish(),
    started_at: z.number().nullish(),
    ended_at: z.number().nullish(),
    end_reason: z.string().nullish(),
    message_count: z.number().nullish(),
    tool_call_count: z.number().nullish(),
    parent_session_id: z.string().nullish(),
    last_active: z.number().nullish(),
    preview: z.string().nullish(),
    _lineage_root_id: z.string().nullish(),
    pinned: z.boolean().nullish(),
    archived: z.boolean().nullish(),
    hidden: z.boolean().nullish(),
    estimated_cost_usd: z.number().nullish(),
  })
  .passthrough();
export type HermesSession = z.infer<typeof hermesSessionSchema>;

export const sessionEnvelopeSchema = z.object({ object: z.string().optional(), session: hermesSessionSchema });

export const sessionListSchema = z.object({
  object: z.literal("list").optional(),
  data: z.array(hermesSessionSchema),
  limit: z.number().optional(),
  offset: z.number().optional(),
  has_more: z.boolean().optional(),
});

export const toolCallSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    function: z.object({ name: z.string(), arguments: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const hermesMessageSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    session_id: z.string().optional(),
    role: z.string(),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    tool_call_id: z.string().nullish(),
    tool_calls: z.array(toolCallSchema).nullish(),
    tool_name: z.string().nullish(),
    timestamp: z.number().nullish(),
    finish_reason: z.string().nullish(),
    reasoning: z.string().nullish(),
    display_kind: z.string().nullish(),
  })
  .passthrough();
export type HermesMessage = z.infer<typeof hermesMessageSchema>;

export const messageListSchema = z.object({
  object: z.string().optional(),
  session_id: z.string().optional(),
  data: z.array(hermesMessageSchema),
  pagination: z.record(z.string(), z.unknown()).optional(),
});

export const runCreatedSchema = z.object({
  run_id: z.string(),
  status: z.string(),
  replayed: z.boolean().optional(),
});

export const RUN_TERMINAL = ["completed", "failed", "cancelled", "interrupted"] as const;
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "stopping"
  | (typeof RUN_TERMINAL)[number];

export const approvalRequestSchema = z
  .object({
    request_id: z.string().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    pattern_key: z.string().optional(),
    choices: z.array(z.string()).optional(),
    allow_session: z.boolean().optional(),
    allow_permanent: z.boolean().optional(),
  })
  .passthrough();

export const runStatusSchema = z
  .object({
    object: z.string().optional(),
    run_id: z.string(),
    status: z.string(),
    session_id: z.string().nullish(),
    created_at: z.number().nullish(),
    updated_at: z.number().nullish(),
    last_event: z.string().nullish(),
    output: z.string().nullish(),
    error: z.string().nullish(),
    pending_steer: z.string().nullish(),
    turn_exit_reason: z.string().nullish(),
    approval: approvalRequestSchema.nullish(),
  })
  .passthrough();
export type HermesRunStatus = z.infer<typeof runStatusSchema>;

export const runEventSchema = z
  .object({
    event: z.string(),
    run_id: z.string().optional(),
    timestamp: z.number().optional(),
    seq: z.number().optional(),
  })
  .passthrough();
export type HermesRunEvent = z.infer<typeof runEventSchema> & Record<string, unknown>;

export const capabilitiesSchema = z
  .object({
    object: z.string().optional(),
    platform: z.string().optional(),
    features: z.record(z.string(), z.unknown()).default({}),
    endpoints: z.record(z.string(), z.object({ method: z.string(), path: z.string() })).default({}),
  })
  .passthrough();
export type HermesCapabilities = z.infer<typeof capabilitiesSchema>;

export const healthSchema = z.object({ status: z.string(), platform: z.string().optional(), version: z.string().optional() }).passthrough();

export const listSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ object: z.string().optional(), data: z.array(item) }).passthrough();

export const skillSchema = z.object({ name: z.string(), description: z.string().nullish(), category: z.string().nullish() }).passthrough();
export const toolsetSchema = z
  .object({
    name: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    enabled: z.boolean().nullish(),
    configured: z.boolean().nullish(),
    tools: z.array(z.string()).nullish(),
  })
  .passthrough();
export const modelSchema = z.object({ id: z.string(), owned_by: z.string().nullish(), parent: z.string().nullish() }).passthrough();

export const jobSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prompt: z.string().nullish(),
    schedule_display: z.string().nullish(),
    enabled: z.boolean().nullish(),
    state: z.string().nullish(),
    next_run_at: z.string().nullish(),
    last_run_at: z.string().nullish(),
    last_status: z.string().nullish(),
    last_error: z.string().nullish(),
    failure_streak: z.number().nullish(),
  })
  .passthrough();
export type HermesJob = z.infer<typeof jobSchema>;
