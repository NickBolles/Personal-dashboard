/**
 * Phase 5 AI actions + capture: shared zod schemas and view types (client-safe,
 * no server imports). Server logic lives in server/ai/*; rules are pure in
 * server/ai/rules.ts. Finance never reaches this layer (docs/security.md).
 */
import { z } from "zod";
import { CONTEXT_SOURCES } from "@/lib/work";

export const AI_ACTION_KINDS = ["research", "plan", "schedule", "draft"] as const;
export type AiActionKind = (typeof AI_ACTION_KINDS)[number];
export const AI_JOB_KINDS = [...AI_ACTION_KINDS, "triage", "investigate"] as const;
export type AiJobKind = (typeof AI_JOB_KINDS)[number];

export const JOB_STATES = ["queued", "running", "waiting_approval", "cancelling", "succeeded", "failed", "cancelled", "budget_blocked", "skipped"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const ACTIVE_JOB_STATES: readonly JobState[] = ["queued", "running", "waiting_approval", "cancelling", "budget_blocked"];
export const TERMINAL_JOB_STATES: readonly JobState[] = ["succeeded", "failed", "cancelled", "skipped"];

export const AI_TIERS = ["triage", "standard", "deep"] as const;
export type AiTier = (typeof AI_TIERS)[number];
export type AiLane = "triage" | "work";

export const JOB_ERROR_CODES = [
  "timeout",
  "approval_required",
  "bad_output",
  "upstream",
  "cost_cap",
  "finance_excluded",
  "hermes_unavailable",
  "cancelled",
  "ai_disabled",
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export const DRAFT_KINDS = ["email", "message", "issue", "pr_description", "doc", "other"] as const;

export const AI_ACTIONS: Record<AiActionKind, { label: string; verb: string; icon: string; tier: AiTier; description: string }> = {
  research: { label: "Research it", verb: "Researching", icon: "✦", tier: "standard", description: "Options, trade-offs and a recommendation, with sources." },
  plan: { label: "Make a plan", verb: "Planning", icon: "☰", tier: "standard", description: "3–12 small steps you can turn into child items." },
  schedule: {
    label: "Suggest a time",
    verb: "Finding a time",
    icon: "◷",
    tier: "triage",
    description: "Estimates the effort; Jarvis finds free slots in your calendars (calendars never go to AI).",
  },
  draft: { label: "Draft it…", verb: "Drafting", icon: "✎", tier: "standard", description: "A draft you copy or continue in the conversation. Never sent." },
};

export const KIND_VERB: Record<AiJobKind, string> = {
  research: "Researching",
  plan: "Planning",
  schedule: "Finding a time",
  draft: "Drafting",
  triage: "Triaging",
  investigate: "Investigating",
};

export const AI_KIND_LABEL: Record<AiJobKind, string> = {
  research: "Research",
  plan: "Plan",
  schedule: "Schedule",
  draft: "Draft",
  triage: "Triage",
  investigate: "Investigation",
};

const clientKey = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const modelId = z.string().trim().min(1).max(120);

export const aiActionSchema = z
  .object({
    action: z.enum(AI_ACTION_KINDS),
    clientKey,
    model: modelId.optional(),
    deep: z.boolean().optional(),
    instructions: z.string().trim().max(1000).optional(),
    contextSources: z.array(z.enum(CONTEXT_SOURCES)).max(CONTEXT_SOURCES.length).optional(),
    draftKind: z.enum(DRAFT_KINDS).optional(),
    durationHint: z
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .optional(),
    budgetOverride: z.boolean().optional(),
  })
  .strict();
export type AiActionInput = z.infer<typeof aiActionSchema>;

export const investigateSchema = z
  .object({
    model: modelId.optional(),
    instructions: z.string().trim().max(1000).optional(),
    budgetOverride: z.boolean().optional(),
    /** owner confirmed "Send anyway" for a heuristic finance match (audited; never for credentials or excluded areas) */
    financeOverride: z.boolean().optional(),
  })
  .strict();

export const retrySchema = z.object({ budgetOverride: z.boolean().optional() }).strict();

export const reportPatchSchema = z
  .object({
    read: z.boolean().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    feedback: z
      .object({ value: z.enum(["useful", "not_useful"]), note: z.string().trim().max(300).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const reportApplySchema = z.discriminatedUnion("what", [
  z.object({ what: z.literal("next_action"), index: z.number().int().min(0).max(10) }).strict(),
  z.object({ what: z.literal("plan_children"), indexes: z.array(z.number().int().min(0).max(20)).max(20).optional() }).strict(),
  z.object({ what: z.literal("dates"), slot: z.number().int().min(0).max(5) }).strict(),
  z.object({ what: z.literal("calendar_event"), slot: z.number().int().min(0).max(5), confirmToken: z.string().max(400).optional() }).strict(),
]);
export type ReportApply = z.infer<typeof reportApplySchema>;

// --- Model output (validated before anything is stored) ---

const s = (max: number) => z.string().trim().max(max);
const sourceOut = z.object({ url: z.string().max(2000), title: s(300).optional().default(""), quote: s(300).optional() }).passthrough();
const commonOut = {
  title: s(120).min(1),
  summary: s(600).default(""),
  body_markdown: s(20_000).default(""),
  sources: z.array(sourceOut).max(40).default([]),
  next_actions: z
    .array(z.object({ title: s(200).min(1), why: s(300).optional().default("") }).passthrough())
    .max(8)
    .default([]),
  open_questions: z.array(s(300)).max(8).default([]),
  assumptions: z.array(s(300)).max(8).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
};

export const researchOutput = z
  .object({
    ...commonOut,
    options: z
      .array(
        z.object({ name: s(120), pros: z.array(s(200)).max(8).default([]), cons: z.array(s(200)).max(8).default([]), fit: s(300).optional() }).passthrough(),
      )
      .max(8)
      .default([]),
    recommendation: s(600).optional(),
  })
  .passthrough();
export const investigateOutput = z.object(commonOut).passthrough();
export const planOutput = z
  .object({
    ...commonOut,
    steps: z
      .array(
        z
          .object({
            title: s(120).min(1),
            detail: s(600).default(""),
            estimateHours: z.number().min(0).max(1000).optional(),
            dependsOn: z.array(z.number().int().min(0).max(20)).max(12).optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(12),
    acceptance: z.array(s(300)).max(10).default([]),
    validation: z
      .object({ metric: s(120), comparator: z.enum(["<=", ">=", "<", ">", "="]), threshold: z.number(), unit: s(20).default("") })
      .passthrough()
      .nullish(),
    risks: z.array(s(300)).max(8).default([]),
  })
  .passthrough();
export const WINDOWS = ["morning", "afternoon", "evening", "weekend", "weekday"] as const;
export const scheduleOutput = z
  .object({
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    splitOk: z.boolean().default(false),
    preferredWindows: z.array(z.enum(WINDOWS)).max(5).default([]),
    earliest: z.string().max(40).nullish(),
    deadline: z.string().max(40).nullish(),
    reason: s(600).default(""),
  })
  .passthrough();
export const draftOutput = z
  .object({
    ...commonOut,
    title: s(120).default("Draft"),
    subject: s(300).optional(),
    body_markdown: s(20_000).min(1),
    variants: z.array(s(20_000)).max(2).default([]),
    notes: s(600).default(""),
  })
  .passthrough();
export const SUGGESTED_KINDS = ["task", "idea", "reference", "question", "bug", "home_issue", "purchase", "other"] as const;
export const triageOutput = z
  .object({
    title: s(120).min(1),
    kind: z.enum(SUGGESTED_KINDS).catch("other"),
    destinationKey: z.string().max(80).nullable().default(null),
    confidence: z.number().min(0).max(1).default(0),
    reason: s(300).default(""),
    shouldInvestigate: z.boolean().default(false),
    brief: s(600).default(""),
    sensitivity: z.enum(["none", "personal", "finance", "credentials"]).catch("none"),
  })
  .passthrough();

export const OUTPUT_SCHEMAS = {
  research: researchOutput,
  investigate: investigateOutput,
  plan: planOutput,
  schedule: scheduleOutput,
  draft: draftOutput,
  triage: triageOutput,
} as const;

// --- Views ---

export type ReportSource = { idx: number; kind: string; url: string | null; title: string; quote: string | null };
export type ScheduleSlot = { start: string; end: string; score: number; why: string };

export type JobView = {
  id: string;
  kind: AiJobKind;
  subjectType: "work_item" | "inbox";
  subjectId: string;
  state: JobState;
  tier: AiTier;
  model: string | null;
  attempt: number;
  estimateUsd: number;
  costUsd: number | null;
  costSource: string | null;
  errorCode: JobErrorCode | null;
  errorMessage: string | null;
  conversationId: string | null;
  reportId: string | null;
  budgetOverride: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ReportView = {
  id: string;
  jobId: string;
  kind: AiJobKind;
  subjectType: "work_item" | "inbox";
  subjectId: string;
  title: string;
  summary: string;
  bodyMd: string;
  structured: Record<string, unknown>;
  confidence: "low" | "medium" | "high";
  model: string | null;
  costUsd: number | null;
  conversationId: string | null;
  readAt: string | null;
  pinnedAt: string | null;
  archivedAt: string | null;
  feedback: { value: "useful" | "not_useful"; note?: string } | null;
  supersededBy: string | null;
  createdAt: string;
  sourceCount: number;
  sources?: ReportSource[];
};

export type ItemAiResponse = { jobs: JobView[]; reports: ReportView[]; policy: { allowed: boolean; reason?: string } };

export type UsageDay = { day: string; jobs: number; costUsd: number; byKind: Record<string, number>; byModel: Record<string, number> };
export type UsageResponse = {
  days: UsageDay[];
  totals: { jobs: number; costUsd: number; overCap: number };
  today: { spentUsd: number; reservedUsd: number; budgetUsd: number };
};

// --- Settings (settings key `ai.settings`; admin) ---

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const usd = z.number().min(0).max(100);
export const aiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    models: z.object({ triage: modelId.nullable(), standard: modelId.nullable(), deep: modelId.nullable() }).strict(),
    dailyBudgetUsd: usd,
    jobCapsUsd: z.object({ triage: usd, standard: usd, deep: usd }).strict(),
    estimatesUsd: z.object({ triage: usd, standard: usd, deep: usd }).strict(),
    concurrency: z.object({ triage: z.number().int().min(1).max(8), work: z.number().int().min(1).max(8) }).strict(),
    timeoutsS: z
      .object({
        triage: z.number().int().min(10).max(3600),
        schedule: z.number().int().min(10).max(3600),
        plan: z.number().int().min(10).max(3600),
        draft: z.number().int().min(10).max(3600),
        research: z.number().int().min(10).max(3600),
        investigate: z.number().int().min(10).max(3600),
      })
      .strict(),
    capture: z
      .object({
        auto: z.enum(["triage_and_investigate", "triage_only", "off"]),
        investigateMinConfidence: z.number().min(0).max(1),
        /** owner decision 2026-10-25: remove GPS from photo metadata before saving; off by default */
        stripLocation: z.boolean().default(false),
      })
      .strict(),
    schedule: z
      .object({
        calendars: z.array(z.string().trim().min(1).max(200)).max(20),
        workHours: z.object({ start: hhmm, end: hhmm, days: z.array(z.number().int().min(0).max(6)).max(7) }).strict(),
        /** owner decision: calendar writes stay OFF in phase 5 */
        calendarWrite: z.object({ enabled: z.boolean(), entityId: z.string().max(200).nullable() }).strict(),
      })
      .strict(),
    /**
     * Hermes capabilities still to verify against the real instance (spec §6.5). Each one
     * gates a behaviour; the defaults are the conservative fallbacks.
     */
    hermes: z
      .object({
        /** send `model` per run (else the Hermes profile default is used) */
        perRunModel: z.boolean(),
        /** session cost updates mid-run: enforce the per-job cap live (else post hoc + timeout) */
        midRunCost: z.boolean(),
        /** runs accept image input (else screenshots are described as "not analysed") */
        imageInput: z.boolean(),
      })
      .strict(),
    dispatchSeconds: z.number().int().min(5).max(600),
  })
  .strict();
export type AiSettings = z.infer<typeof aiSettingsSchema>;

/** Owner decision 2026-10-25: $5/day; caps triage $0.03, standard $0.75, deep $2.50; hard stop + Run anyway. */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  models: { triage: null, standard: null, deep: null },
  dailyBudgetUsd: 5,
  jobCapsUsd: { triage: 0.03, standard: 0.75, deep: 2.5 },
  estimatesUsd: { triage: 0.01, standard: 0.25, deep: 1 },
  concurrency: { triage: 2, work: 2 },
  timeoutsS: { triage: 90, schedule: 120, plan: 300, draft: 300, research: 900, investigate: 600 },
  capture: { auto: "triage_and_investigate", investigateMinConfidence: 0.6, stripLocation: false },
  schedule: { calendars: [], workHours: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] }, calendarWrite: { enabled: false, entityId: null } },
  hermes: { perRunModel: false, midRunCost: false, imageInput: false },
  dispatchSeconds: 30,
};

export const aiSettingsPatchSchema = aiSettingsSchema.partial().strict();

// --- Capture ---

export const CAPTURE_CHANNELS = ["web", "pwa_share", "android", "shortcut", "voice", "api"] as const;
export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];
export const CAPTURE_LIMITS = { totalBytes: 25 * 1024 * 1024, files: 4, fileBytes: 10 * 1024 * 1024, text: 8000, url: 2000, title: 200 } as const;
export const CAPTURE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"] as const;

export const captureFieldsSchema = z
  .object({
    text: z.string().max(CAPTURE_LIMITS.text).optional(),
    title: z.string().trim().max(CAPTURE_LIMITS.title).optional(),
    url: z
      .string()
      .trim()
      .max(CAPTURE_LIMITS.url)
      .refine((v) => !v || /^https?:\/\//i.test(v), "Use an http(s) link")
      .optional(),
    channel: z.enum(CAPTURE_CHANNELS).optional(),
    clientCaptureId: z
      .string()
      .min(8)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    investigate: z.enum(["auto", "triage_only", "off"]).optional(),
    /** file directly under this work item (still triaged/investigated when on) */
    parentId: z.string().min(1).max(80).optional(),
    /** offline replays: the account that queued it; refused (409) when another account is signed in */
    queuedBy: z.string().min(1).max(80).optional(),
  })
  .strict();
export type CaptureFields = z.infer<typeof captureFieldsSchema>;

export const captureTokenCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    expiresInDays: z.number().int().min(1).max(730).optional(),
    ratePerHour: z.number().int().min(1).max(120).optional(),
    ratePerDay: z.number().int().min(1).max(1000).optional(),
    investigateMode: z.enum(["inherit", "triage_only", "off"]).optional(),
  })
  .strict();

export type CaptureTokenView = {
  id: string;
  label: string;
  prefixHint: string;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  expiresAt: string;
  revokedAt: string | null;
  ratePerHour: number;
  ratePerDay: number;
  investigateMode: "inherit" | "triage_only" | "off";
};

export type AttachmentView = { id: string; kind: "image" | "text"; mime: string; bytes: number; width: number | null; height: number | null; url: string };

export const usd2 = (n: number | null | undefined) => (n == null ? "—" : `$${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`);
