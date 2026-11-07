/**
 * Phase 4 lane 2: scheduled coordinator jobs, "While you were away" digest and
 * per-area autonomy (#217). Shared contract (server + client): types, zod
 * schemas, pure schedule maths (DST-correct) and the autonomy policy matrix.
 *
 * Rules (owner, 2026-11-07):
 * - Every schedule ships DISABLED; the owner enables it.
 * - Missed windows are skipped, never replayed; one run per (job, slot).
 * - A slot inside quiet hours runs only when the job is marked `overnight`.
 * - Autonomy is per area: `propose` (default) or `low_risk`. Finance /
 *   AI-excluded areas are forced `off` (no AI at all).
 * - Low-risk = an explicit allowlist of intents. Everything else becomes a
 *   Needs-you decision; some intents are never done by Jarvis at all.
 */
import { z } from "zod";
import { addDays, localDate, localMinutes, localTimeToInstant, MINUTE, parseHHMM, inWindow } from "./time";
import { isFinanceAreaLike } from "./catch-up";
import { AUTONOMY_MODES, type AutonomyMode } from "./work";

export { AUTONOMY_MODES, type AutonomyMode };

/* ---------------- schedules ---------------- */

export const SCHEDULE_FREQS = ["daily", "weekdays", "weekly"] as const;
export type ScheduleFreq = (typeof SCHEDULE_FREQS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const scheduleSpecSchema = z
  .object({
    freq: z.enum(SCHEDULE_FREQS),
    /** 24h local wall time */
    time: hhmm,
    /** weekly only: 0 = Sunday … 6 = Saturday (at least one) */
    days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  })
  .strict()
  .refine((s) => s.freq !== "weekly" || s.days.length > 0, { message: "Pick at least one day", path: ["days"] });
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export const JOB_KINDS = ["brief", "triage", "review", "stalled", "custom"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  brief: "Morning brief",
  triage: "Inbox triage",
  review: "Weekly review prep",
  stalled: "Check stalled agent runs",
  custom: "Custom prompt",
};

/** Floors (policy, not settings). */
export const MAX_JOBS = 12;
export const DEFAULT_MAX_RUNS_PER_DAY = 6;
/** A slot later than this after its time is a missed window: skipped, not replayed. */
export const SLOT_GRACE_MS = 30 * MINUTE;
/** Consecutive failures that switch a job off (and tell the owner). */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** A run still not finished after this is marked failed ("timed out"). */
export const RUN_TIMEOUT_MS = 2 * 60 * MINUTE;
/** Proposals read from one run's output (the rest are dropped and said so). */
export const MAX_PROPOSALS_PER_RUN = 10;

export const jobInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** the area (or project) whose coordinator runs it; null = the global coordinator area */
    areaId: z.string().min(1).max(64).nullable(),
    kind: z.enum(JOB_KINDS),
    prompt: z.string().trim().min(1).max(4000),
    schedule: scheduleSpecSchema,
    /** may run inside quiet hours (overnight jobs); never pushes during them */
    overnight: z.boolean().default(false),
    enabled: z.boolean().default(false),
  })
  .strict();
export type JobInput = z.infer<typeof jobInputSchema>;
export const jobPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    areaId: z.string().min(1).max(64).nullable(),
    kind: z.enum(JOB_KINDS),
    prompt: z.string().trim().min(1).max(4000),
    schedule: scheduleSpecSchema,
    overnight: z.boolean(),
    enabled: z.boolean(),
  })
  .partial()
  .strict();
export type JobPatch = z.infer<typeof jobPatchSchema>;

export const JOB_STATUSES = ["never", "running", "ok", "silent", "failed", "skipped_quiet", "skipped_cap", "skipped_policy"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  never: "Never ran",
  running: "Running",
  ok: "Done",
  silent: "Nothing new",
  failed: "Failed",
  skipped_quiet: "Skipped · quiet hours",
  skipped_cap: "Skipped · daily cap",
  skipped_policy: "Skipped · AI off here",
};

/** One job as the API returns it. */
export type ScheduledJob = {
  id: string;
  title: string;
  areaId: string | null;
  areaTitle: string | null;
  kind: JobKind;
  prompt: string;
  schedule: ScheduleSpec;
  overnight: boolean;
  enabled: boolean;
  /** suggested template key (seeded disabled) or null */
  templateKey: string | null;
  tz: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: JobStatus;
  lastError: string | null;
  consecutiveFailures: number;
  /** effective autonomy of the job's area */
  autonomy: EffectiveAutonomy;
  createdAt: string;
  updatedAt: string;
};

export type JobRunStatus = "running" | "done" | "failed" | "skipped";
/** One scheduled run in the digest. */
export type AwayRun = {
  id: string;
  jobId: string;
  jobTitle: string;
  areaId: string | null;
  areaTitle: string | null;
  slot: string;
  manual: boolean;
  status: JobRunStatus;
  /** silent = finished with nothing to report */
  silent: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** short plain-text excerpt of the agent's report (≤ 600 chars) */
  summary: string | null;
  error: string | null;
  /** the job's conversation (opens the full report) */
  sessionId: string | null;
  agentRunId: string | null;
  profile: string | null;
  /** low-risk changes Jarvis applied (each undoable from Activity) */
  changes: { intent: ProposalIntent; label: string; itemId: string | null; itemTitle: string | null }[];
  /** proposals turned into Needs-you decisions (still open ones only count in `needsYou`) */
  decisions: { itemId: string; itemTitle: string; question: string; open: boolean }[];
  /** proposals Jarvis refused outright (merge/deploy/spend/send) */
  refused: { intent: string; label: string }[];
};

export type AwayDigest = {
  /** runs since the owner last dismissed the digest (newest first, max 20) */
  runs: AwayRun[];
  since: string | null;
  counts: { ran: number; failed: number; changes: number; needsYou: number; running: number };
  /** one-line text for the tray's dynamic line, null when nothing to say */
  line: string | null;
};

/** JSON export/import file. */
export const JOBS_EXPORT_VERSION = 1;
export const jobsExportSchema = z.object({
  version: z.literal(JOBS_EXPORT_VERSION),
  exportedAt: z.string(),
  jobs: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        /** areas are matched by title on import (ids differ between installs) */
        areaTitle: z.string().max(200).nullable(),
        kind: z.enum(JOB_KINDS),
        prompt: z.string().trim().min(1).max(4000),
        schedule: scheduleSpecSchema,
        overnight: z.boolean().default(false),
      }),
    )
    .max(MAX_JOBS),
});
export type JobsExport = z.infer<typeof jobsExportSchema>;

/** Suggested templates seeded (disabled) once per owner. */
export const SUGGESTED_TEMPLATES: (Omit<JobInput, "areaId" | "enabled"> & { key: string })[] = [
  {
    key: "overnight-triage-brief",
    title: "Overnight: triage Inbox + prepare morning brief",
    kind: "brief",
    overnight: true,
    schedule: { freq: "daily", time: "05:30", days: [] },
    prompt:
      "Overnight check-in. Read only what changed since your last check-in. Suggest where each new Inbox capture belongs, " +
      "note any agent runs that stalled or failed, and write a short morning brief: what needs me today, what changed, what you couldn't check. " +
      "If nothing changed, say exactly NOTHING_NEW.",
  },
  {
    key: "weekly-review-prep",
    title: "Weekly review prep",
    kind: "review",
    overnight: false,
    schedule: { freq: "weekly", time: "15:00", days: [5] },
    prompt:
      "Prepare my weekly review: per project, what moved this week, what is stuck and the one next action you'd suggest. " +
      "List items that look ready to settle as proposals only (never settle). If nothing changed, say exactly NOTHING_NEW.",
  },
];

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday (0 = Sunday) of a YYYY-MM-DD calendar date. */
export function weekdayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function runsOnDay(s: ScheduleSpec, date: string) {
  const wd = weekdayOf(date);
  if (s.freq === "daily") return true;
  if (s.freq === "weekdays") return wd >= 1 && wd <= 5;
  return s.days.includes(wd);
}

/** "Daily 05:30", "Weekdays 07:30", "Fri 15:00", "Mon, Thu 09:00". */
export function describeSchedule(s: ScheduleSpec) {
  const t = s.time;
  if (s.freq === "daily") return `Daily ${t}`;
  if (s.freq === "weekdays") return `Weekdays ${t}`;
  return `${[...s.days]
    .sort()
    .map((d) => DOW[d])
    .join(", ")} ${t}`;
}

/**
 * The slot instant (UTC) of the schedule on a local calendar date, DST-correct
 * (wall time resolved at that date's offset; a time inside a spring-forward
 * gap moves forward). Null when the schedule doesn't run that day.
 */
export function slotOn(s: ScheduleSpec, date: string, tz: string): Date | null {
  return runsOnDay(s, date) ? localTimeToInstant(date, s.time, tz) : null;
}

/** First slot strictly after `after`. Searches 8 days (weekly schedules always hit). */
export function nextRunAt(s: ScheduleSpec, after: Date, tz: string): Date | null {
  const today = localDate(after, tz);
  for (let i = 0; i <= 8; i++) {
    const at = slotOn(s, addDays(today, i), tz);
    if (at && at.getTime() > after.getTime()) return at;
  }
  return null;
}

/**
 * The slot due at `now`: the latest slot at or before `now` that is still
 * within the grace window. Null = nothing due (or the window was missed).
 */
export function dueSlot(s: ScheduleSpec, now: Date, tz: string, graceMs = SLOT_GRACE_MS): Date | null {
  const today = localDate(now, tz);
  for (const date of [today, addDays(today, -1)]) {
    const at = slotOn(s, date, tz);
    if (at && at.getTime() <= now.getTime() && now.getTime() - at.getTime() <= graceMs) return at;
  }
  return null;
}

/** Stable idempotency key of a slot: one run per (job, slot). */
export const slotKey = (at: Date) => at.toISOString().slice(0, 16) + "Z";
export const manualSlotKey = (now: Date) => `manual:${now.toISOString().slice(0, 16)}Z`;

export type QuietHours = { enabled: boolean; start: string; end: string };
export function inQuietHours(at: Date, q: QuietHours | null | undefined, tz: string) {
  if (!q?.enabled) return false;
  return inWindow(localMinutes(at, tz), q.start, q.end);
}

/** When quiet hours end after `at` (for deferring a push); `at` itself when not quiet. */
export function quietEnd(at: Date, q: QuietHours | null | undefined, tz: string): Date {
  if (!inQuietHours(at, q, tz) || !q) return at;
  const day = localDate(at, tz);
  const endToday = localTimeToInstant(day, q.end, tz);
  if (endToday.getTime() > at.getTime()) return endToday;
  return localTimeToInstant(addDays(day, 1), q.end, tz);
}

export const minutesOf = parseHHMM;

/* ---------------- autonomy (#217) ---------------- */

export type EffectiveAutonomy = AutonomyMode | "off";
export const AUTONOMY_LABELS: Record<EffectiveAutonomy, string> = {
  propose: "Propose only",
  low_risk: "Act on low-risk",
  off: "AI off",
};

/** Intents a scheduled run may propose (in its `jarvis-proposals` block). */
export const PROPOSAL_INTENTS = [
  // low-risk allowlist
  "create_note",
  "create_thread",
  "update_next_action",
  "file_to_inbox",
  // needs the owner
  "update_status",
  "set_assignee",
  "create_project",
  "add_link",
  "raise_decision",
  "settle",
  "abandon",
  "supersede",
  "archive",
  "move",
  // never (Jarvis refuses; the owner does these outside Jarvis)
  "merge",
  "deploy",
  "spend",
  "send_external",
] as const;
export type ProposalIntent = (typeof PROPOSAL_INTENTS)[number];

export const LOW_RISK_INTENTS: readonly ProposalIntent[] = ["create_note", "create_thread", "update_next_action", "file_to_inbox"];
export const NEVER_INTENTS: readonly ProposalIntent[] = ["merge", "deploy", "spend", "send_external"];

export const proposalSchema = z
  .object({
    intent: z.enum(PROPOSAL_INTENTS),
    /** target item (parent for create_*); omitted = the job's area */
    itemId: z.string().min(1).max(64).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    text: z.string().trim().max(4000).optional(),
    /** one-line reason shown to the owner */
    why: z.string().trim().max(300).optional(),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;

export type PolicyOutcome = "apply" | "decision" | "refuse";

/** Finance / AI-excluded areas are always off; triage-only areas can only propose. */
export function effectiveAutonomy(area: {
  title: string;
  systemKey?: string | null;
  settings?: { autonomy?: AutonomyMode | null; aiPolicy?: string | null } | null;
}): EffectiveAutonomy {
  if (isFinanceAreaLike(area) || area.settings?.aiPolicy === "excluded") return "off";
  if (area.settings?.aiPolicy === "triage_only") return "propose";
  return area.settings?.autonomy === "low_risk" ? "low_risk" : "propose";
}

/** The policy matrix: what Jarvis does with one proposal in an area. */
export function policyFor(mode: EffectiveAutonomy, intent: ProposalIntent): PolicyOutcome {
  if (mode === "off") return "refuse";
  if (NEVER_INTENTS.includes(intent)) return "refuse";
  if (mode === "low_risk" && LOW_RISK_INTENTS.includes(intent)) return "apply";
  return "decision";
}

export const PROPOSALS_FENCE = "jarvis-proposals";
export const NOTHING_NEW = "NOTHING_NEW";

/**
 * Parse the run's report: the last ```jarvis-proposals fenced JSON array.
 * Invalid entries are dropped (counted); never throws.
 */
export function parseProposals(output: string | null | undefined): { proposals: Proposal[]; dropped: number; report: string } {
  const text = output ?? "";
  const re = new RegExp("```" + PROPOSALS_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  const report = text.replace(re, "").trim();
  if (!last) return { proposals: [], dropped: 0, report };
  let raw: unknown;
  try {
    raw = JSON.parse(last[1]!);
  } catch {
    return { proposals: [], dropped: 1, report };
  }
  const list = Array.isArray(raw) ? raw : [];
  const proposals: Proposal[] = [];
  let dropped = Array.isArray(raw) ? 0 : 1;
  for (const p of list) {
    const r = proposalSchema.safeParse(p);
    if (r.success && proposals.length < MAX_PROPOSALS_PER_RUN) proposals.push(r.data);
    else dropped++;
  }
  return { proposals, dropped, report };
}

/** The run is "silent" when the agent said NOTHING_NEW and proposed nothing. */
export const isSilentReport = (report: string, proposals: Proposal[]) => proposals.length === 0 && report.trim().replace(/[.!]/g, "") === NOTHING_NEW;

/** Policy text appended to every scheduled run's prompt. */
export function policyInstructions(mode: EffectiveAutonomy) {
  return [
    "You are running unattended on a schedule (the owner is away). Do not make changes yourself with tools.",
    `At the end, list proposed changes as a fenced block \`\`\`${PROPOSALS_FENCE}\\n[ {"intent": …, "itemId"?: …, "title"?: …, "text"?: …, "why"?: …} ]\\n\`\`\` (JSON array, at most ${MAX_PROPOSALS_PER_RUN}).`,
    `Intents: ${PROPOSAL_INTENTS.join(", ")}.`,
    mode === "low_risk"
      ? `This area allows Jarvis to apply low-risk proposals (${LOW_RISK_INTENTS.join(", ")}) automatically with undo; everything else goes to the owner as a decision.`
      : "Every proposal goes to the owner as a decision; nothing is applied automatically.",
    "Never settle, abandon, supersede, merge, deploy, spend money or message anyone; propose instead. Never include finance data.",
    `If nothing changed since your last check-in, reply exactly ${NOTHING_NEW}.`,
  ].join("\n");
}
