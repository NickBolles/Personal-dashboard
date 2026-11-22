/**
 * CW-2/CW-4 run tracking: R-n display ids, pipeline chips, locks and structured run
 * events (folded completion notices). Client-safe; persistence in server/work/run-events.ts.
 */
import { z } from "zod";

export const RUN_REF = /^R-([1-9]\d{0,8})$/;
export const runRef = (seq: number | null | undefined) => (seq ? `R-${seq}` : null);
export function parseRunRef(ref: string): number | null {
  const m = RUN_REF.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

export const PIPELINE_STAGES = ["build", "ci", "review", "merge", "deploy", "live"] as const;
export const PIPELINE_STATES = ["pending", "running", "ok", "failed", "skipped"] as const;
export const pipelineSchema = z
  .array(
    z
      .object({
        stage: z.enum(PIPELINE_STAGES),
        state: z.enum(PIPELINE_STATES),
        label: z.string().trim().max(80).optional(),
        url: z.string().trim().max(500).optional(),
      })
      .strict(),
  )
  .max(PIPELINE_STAGES.length);
export type Pipeline = z.infer<typeof pipelineSchema>;

export const lockSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    holder: z.string().trim().max(120).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    /** holds = this run has it; waits = blocked on it */
    mode: z.enum(["holds", "waits"]).optional(),
  })
  .strict();
export type RunLock = z.infer<typeof lockSchema>;

/**
 * Event types. `notice` = a folded process/delegation completion notice (CW-4: never its
 * own chat message); the others mirror R9 of the design.
 */
export const RUN_EVENT_TYPES = [
  "progress",
  "notice",
  "lock.acquired",
  "lock.released",
  "ci",
  "release.staged",
  "release.live",
  "started",
  "done",
  "failed",
  "interrupted",
  "resumed",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];
/** Types only Jarvis writes (from run_start / run_update); agents send the rest via jarvis_run_event. */
export const SYSTEM_RUN_EVENTS: readonly RunEventType[] = ["started", "done", "failed", "interrupted", "resumed"];

/**
 * The key moments of a task (task threads D4): started, found, made, asked, decided, blocked, handed off, resumed,
 * stopped, failed, done. Each is one line under 140 characters. An agent reports the four it can know itself
 * (found, made, blocked, handed off) as `moment` on a `progress` event; Jarvis writes the rest from what happens
 * (a run starting, a question, an answer, a stop, an end).
 */
export const AGENT_MOMENTS = ["found", "made", "blocked", "handed_off"] as const;
export type AgentMoment = (typeof AGENT_MOMENTS)[number];
export const MOMENT_MAX = 140;
export const momentOfPayload = (payload: Record<string, unknown> | null | undefined): AgentMoment | null =>
  typeof payload?.moment === "string" && (AGENT_MOMENTS as readonly string[]).includes(payload.moment) ? (payload.moment as AgentMoment) : null;

export type RunEvent = {
  id: string;
  runId: string;
  runRef: string | null;
  type: RunEventType;
  summary: string;
  payload: Record<string, unknown>;
  via: string | null;
  at: string;
};

export function parsePipeline(raw: string | null | undefined): Pipeline {
  if (!raw) return [];
  try {
    const r = pipelineSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}
export function parseLock(raw: string | null | undefined): RunLock | null {
  if (!raw) return null;
  try {
    const r = lockSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Owner surfaces with a "last looked" marker. */
export const LOOK_SURFACES = ["chat", "needs", "running", "changes", "context"] as const;
export type LookSurface = (typeof LOOK_SURFACES)[number];
