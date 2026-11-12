/**
 * Capture AI triage (owner request 2026-11-12): every capture is looked at by AI to see whether
 * Jarvis can resolve it. Shared, client-safe contract: the AI action schema (validated model
 * output), the owner's settings, the pure gating rules (`decideTriage`) and the view types the
 * UI renders. Server logic: server/capture/triage.ts (apply) and server/ai/runner.ts (plan).
 *
 * Outcomes:
 * - auto: low-risk + reversible + confidently understood + allowed → done through the existing
 *   write paths (Skylight list add / calendar event, Jarvis task), capture becomes a ready-to-settle
 *   item with Undo. Never settled by Jarvis.
 * - needs_input: something essential is missing (an appointment without a date/time) → one D-n.
 * - suggest: risky or outside the allowlist (devices, messages, money, deletes) → shown, never done.
 * - file: just a note/idea → filed with a next action (or left as a suggestion).
 */
import { z } from "zod";

/** Truncating string (model output is clipped, never rejected for length). */
const t = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().slice(0, max))
    .catch("");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const CAPTURE_ACTION_TYPES = [
  "skylight_list_add",
  "skylight_event_create",
  "jarvis_task",
  "note",
  "ha_device",
  "message",
  "purchase",
  "finance",
  "delete",
  "other",
  "none",
] as const;
export type CaptureActionType = (typeof CAPTURE_ACTION_TYPES)[number];

/** Never done by Jarvis on its own: shown as a suggestion only. */
export const RISKY_ACTION_TYPES: readonly CaptureActionType[] = ["ha_device", "message", "purchase", "finance", "delete", "other"];

const eventSchema = z
  .object({
    summary: t(200),
    date: day.nullable().catch(null).default(null),
    time: hhmm.nullable().catch(null).default(null),
    durationMinutes: z.number().int().min(5).max(1440).nullable().catch(null).default(null),
    allDay: z.boolean().catch(false).default(false),
    location: t(200).nullable().default(null),
  })
  .strip();

const baseAction = {
  type: z.enum(CAPTURE_ACTION_TYPES).catch("other"),
  /** Skylight list id from the provided lists (validated server-side) */
  listId: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).slice(0, 40))
    .nullable()
    .catch(null)
    .default(null),
  /** item text for a list add / title for a Jarvis task */
  label: t(200).nullable().default(null),
  event: eventSchema.nullable().catch(null).default(null),
};

/** `choice` = the button text the owner sees; the rest is the action that choice runs. */
const choiceSchema = z
  .object({ choice: t(120), ...baseAction })
  .strip()
  .refine((c) => c.choice.length > 0);

/** The `action` block of the triage@2 output (model output → validated here, never trusted further). */
export const triageActionSchema = z
  .object({
    ...baseAction,
    confidence: z.number().min(0).max(1).catch(0).default(0),
    /** one line: what Jarvis would do */
    summary: t(200).default(""),
    /** essential fields that are missing (e.g. "date", "time") → needs input */
    missing: z.array(t(40)).max(5).catch([]).default([]),
    question: t(300).nullable().default(null),
    choices: z.array(choiceSchema).max(4).catch([]).default([]),
  })
  .strip();
export type TriageAction = z.infer<typeof triageActionSchema>;

// --- Owner settings (Settings → AI → Captures) ---

export const captureActionSettingsSchema = z
  .object({
    /** "Auto-handle captures" (default ON): off = classification + filing suggestion only, as before */
    autoHandle: z.boolean(),
    /** "triage_only" = never act: everything actionable becomes a suggestion */
    mode: z.enum(["act", "triage_only"]),
    allow: z.object({ skylightList: z.boolean(), skylightEvent: z.boolean(), jarvisTask: z.boolean() }).strict(),
    /** minimum model confidence for acting without asking */
    minConfidence: z.number().min(0.5).max(1),
  })
  .strict();
export type CaptureActionSettings = z.infer<typeof captureActionSettingsSchema>;
export const DEFAULT_CAPTURE_ACTIONS: CaptureActionSettings = {
  autoHandle: true,
  mode: "act",
  allow: { skylightList: true, skylightEvent: true, jarvisTask: true },
  minConfidence: 0.75,
};

// --- Resolved actions (what the server executes) ---

export type SkylightListRef = { id: string; label: string; kind: string };

export type ResolvedAction =
  | { type: "skylight_list_add"; listId: string; listLabel: string; label: string }
  | {
      type: "skylight_event_create";
      summary: string;
      date: string;
      time: string | null;
      allDay: boolean;
      durationMinutes: number;
      location: string | null;
    }
  | { type: "jarvis_task"; title: string; nextAction: string };

export type TriageChoice = { label: string; action: ResolvedAction | null };

export type TriageOutcome =
  | { kind: "auto"; action: ResolvedAction }
  | { kind: "needs_input"; question: string; choices: TriageChoice[]; recommended: string | null; missing: string[] }
  | { kind: "suggest"; summary: string; reason: "risky" | "not_allowed" | "triage_only" | "low_confidence" | "backfill" | "no_list" }
  | { kind: "file"; summary: string }
  | { kind: "skip"; reason: "off" };

const SHOPPING = /\b(buy|get|pick up|grocer|milk|eggs|bread|butter|cheese|shopping|store|costco|target|walmart)\b/i;

/** Pick a list: the model's id if real, else by name, else by kind (shopping words → shopping list, else first to-do). */
export function pickList(lists: SkylightListRef[], listId: string | null, hint: string): SkylightListRef | null {
  if (!lists.length) return null;
  const byId = listId ? lists.find((l) => l.id === listId) : undefined;
  if (byId) return byId;
  const h = hint.toLowerCase();
  const named = lists.find((l) => l.label && h.includes(l.label.toLowerCase()));
  if (named) return named;
  if (/\bgrocer/i.test(hint)) {
    const g = lists.find((l) => /grocer/i.test(l.label)) ?? lists.find((l) => l.kind === "shopping");
    if (g) return g;
  }
  if (SHOPPING.test(hint)) {
    const s = lists.find((l) => l.kind === "shopping") ?? lists.find((l) => /shopping|grocer/i.test(l.label));
    if (s) return s;
  }
  return lists.find((l) => l.kind === "to_do") ?? lists[0]!;
}

/** "Add Replace key batter on skylight" → "Replace key batter": the capture minus the routing words. */
export function stripRouting(text: string): string {
  const out = text
    .replace(/\b(?:to|on|in|onto)\s+(?:the\s+)?skylight(?:\s+(?:list|calendar|app))?\b/gi, "")
    .replace(/\bskylight\b/gi, "")
    .replace(/^\s*(?:please\s+)?add\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return (out || text.trim()).slice(0, 200);
}

/** The capture names the target system (back-fill only acts on these, so nothing surprising happens). */
export function namesTarget(text: string, type: CaptureActionType): boolean {
  if (type === "skylight_list_add" || type === "skylight_event_create") return /\bskylight\b/i.test(text);
  return false;
}

type Base = Pick<TriageAction, "type" | "listId" | "label" | "event">;

/** Resolve one action against the owner's real lists; null = can't be done as stated (missing fields). */
export function resolveAction(a: Base, ctx: { lists: SkylightListRef[]; title: string }): ResolvedAction | null | "no_list" {
  if (a.type === "skylight_list_add") {
    const label = (a.label || stripRouting(ctx.title)).trim();
    if (!label) return null;
    const list = pickList(ctx.lists, a.listId, `${ctx.title} ${label}`);
    if (!list) return "no_list";
    return { type: "skylight_list_add", listId: list.id, listLabel: list.label, label };
  }
  if (a.type === "skylight_event_create") {
    const e = a.event;
    if (!e || !e.date || (!e.time && !e.allDay)) return null;
    return {
      type: "skylight_event_create",
      summary: (e.summary || a.label || stripRouting(ctx.title)).trim().slice(0, 200),
      date: e.date,
      time: e.allDay ? null : e.time,
      allDay: !!e.allDay || !e.time,
      durationMinutes: e.durationMinutes ?? 60,
      location: e.location || null,
    };
  }
  if (a.type === "jarvis_task") {
    const title = (a.label || ctx.title).trim().slice(0, 200);
    return title ? { type: "jarvis_task", title, nextAction: title } : null;
  }
  return null;
}

const ALLOW_KEY: Partial<Record<CaptureActionType, keyof CaptureActionSettings["allow"]>> = {
  skylight_list_add: "skylightList",
  skylight_event_create: "skylightEvent",
  jarvis_task: "jarvisTask",
};

export function describeAction(a: ResolvedAction): string {
  switch (a.type) {
    case "skylight_list_add":
      return `Add “${a.label}” to ${a.listLabel} on Skylight`;
    case "skylight_event_create":
      return `Add “${a.summary}” to the family calendar on ${a.date}${a.time ? ` at ${a.time}` : " (all day)"}`;
    case "jarvis_task":
      return `Keep “${a.title}” as a Jarvis to-do`;
  }
}

/** Past tense for the ready-to-settle summary ("Done: …"). */
export function doneText(a: ResolvedAction): string {
  switch (a.type) {
    case "skylight_list_add":
      return `added “${a.label}” to ${a.listLabel} on Skylight`;
    case "skylight_event_create":
      return `added “${a.summary}” to the family calendar on ${a.date}${a.time ? ` at ${a.time}` : " (all day)"}`;
    case "jarvis_task":
      return `filed “${a.title}” as a Jarvis to-do`;
  }
}

/**
 * The gate (pure). `chosen` = the owner picked this action in a decision: consent, so the confidence,
 * mode, allowlist and back-fill limits don't apply — but risky types still never run.
 */
export function decideTriage(
  action: TriageAction | null,
  ctx: { settings: CaptureActionSettings; lists: SkylightListRef[]; title: string; text: string; backfill?: boolean; chosen?: boolean },
): TriageOutcome {
  const s = ctx.settings;
  if (!s.autoHandle && !ctx.chosen) return { kind: "skip", reason: "off" };
  if (!action || action.type === "none" || action.type === "note") return { kind: "file", summary: action?.summary || "Filed as a note" };
  const summary = action.summary || "Suggested action";
  if (RISKY_ACTION_TYPES.includes(action.type)) return { kind: "suggest", summary, reason: "risky" };
  const resolved = resolveAction(action, { lists: ctx.lists, title: ctx.title });
  if (resolved === "no_list") return { kind: "suggest", summary, reason: "no_list" };
  const missing = action.missing.filter(Boolean);
  if (!resolved || (missing.length && !ctx.chosen)) return needsInput(action, ctx, missing);
  if (ctx.chosen) return { kind: "auto", action: resolved };
  if (s.mode === "triage_only") return { kind: "suggest", summary: describeAction(resolved), reason: "triage_only" };
  const key = ALLOW_KEY[action.type];
  if (!key || !s.allow[key]) return { kind: "suggest", summary: describeAction(resolved), reason: "not_allowed" };
  if (action.confidence < s.minConfidence) return { kind: "suggest", summary: describeAction(resolved), reason: "low_confidence" };
  if (ctx.backfill && !namesTarget(ctx.text, action.type)) return { kind: "suggest", summary: describeAction(resolved), reason: "backfill" };
  return { kind: "auto", action: resolved };
}

function needsInput(
  action: TriageAction,
  ctx: { lists: SkylightListRef[]; title: string },
  missing: string[],
): Extract<TriageOutcome, { kind: "needs_input" }> {
  const name = stripRouting(action.event?.summary || action.label || ctx.title);
  const choices: TriageChoice[] = [];
  const seen = new Set<string>();
  const push = (label: string, a: ResolvedAction | null) => {
    const l = label.trim().slice(0, 120);
    if (!l || seen.has(l.toLowerCase()) || choices.length >= 4) return;
    seen.add(l.toLowerCase());
    choices.push({ label: l, action: a });
  };
  for (const c of action.choices) {
    if (RISKY_ACTION_TYPES.includes(c.type)) continue;
    const r = resolveAction(c, ctx);
    push(c.choice, r && r !== "no_list" ? r : null);
  }
  // Sensible defaults: put it on a Skylight to-do list, or keep it as a Jarvis to-do. Never a guessed date.
  const todo = ctx.lists.find((l) => l.kind === "to_do") ?? ctx.lists[0];
  if (todo && !choices.some((c) => c.action?.type === "skylight_list_add"))
    push(`Add “${name}” to ${todo.label} on Skylight`, { type: "skylight_list_add", listId: todo.id, listLabel: todo.label, label: name });
  if (!choices.some((c) => c.action?.type === "jarvis_task")) push("Just keep it as a Jarvis to-do", { type: "jarvis_task", title: name, nextAction: name });
  const question =
    action.question ||
    (action.type === "skylight_event_create"
      ? `When is “${name}”? I need a date and time to put it on the family calendar.`
      : `How should I handle “${name}”?`);
  return { kind: "needs_input", question, choices, recommended: choices[0]?.label ?? null, missing };
}

/** Stable hash input for idempotency (capture id + action). */
export function actionKey(a: ResolvedAction): string {
  return JSON.stringify(a);
}

// --- Views (API → UI) ---

export const CAPTURE_TRIAGE_STATES = ["planned", "applying", "done", "needs_input", "suggested", "filed", "failed", "undone", "skipped"] as const;
export type CaptureTriageState = (typeof CAPTURE_TRIAGE_STATES)[number];

export type CaptureTriageView = {
  id: string;
  inboxId: string;
  state: CaptureTriageState;
  /** one line, e.g. "Done: added “Replace key battery” to House projects on Skylight" */
  summary: string;
  /** the work item the capture became (ready to settle / needs you / filed) */
  itemId: string | null;
  /** D-n when it needs input */
  decisionRef: string | null;
  /** R-n of the triage run */
  runRef: string | null;
  /** Undo of the external write is still possible (24 h) */
  undoable: boolean;
  /** where to check or correct the created object (same-origin path) */
  openHref: string | null;
  openLabel: string | null;
  error: string | null;
  /** a suggestion Jarvis can do once the owner confirms ("Do it") */
  canApply?: boolean;
  at: string;
};

export const TRIAGE_CHIP: Record<CaptureTriageState, string> = {
  planned: "Triaging…",
  applying: "Triaging…",
  done: "Done",
  needs_input: "Needs you",
  suggested: "Suggested",
  filed: "Filed",
  failed: "Triage failed",
  undone: "Undone",
  skipped: "Left as captured",
};
