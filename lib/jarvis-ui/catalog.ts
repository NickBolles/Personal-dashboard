import { z } from "zod";

/**
 * Catalog `jarvis-ui@1`: the closed component vocabulary smart replies may
 * use (docs/smart-ui.md). Pure zod, no React, shared by the web renderer,
 * the server (validation, intent binding) and the test fixtures. Props are
 * strict: no style props, no HTML, no URLs, no `$state`/`$computed`
 * expressions. Anything unknown is dropped by the validator.
 */
export const CATALOG_ID = "jarvis-ui@1";
export const FENCE = "jarvis-ui";

export const LIMITS = {
  blockBytes: 64 * 1024,
  elements: 200,
  depth: 8,
  blocksPerMessage: 3,
  stringChars: 2000,
  listRows: 100,
  tableRows: 50,
  stateBytes: 16 * 1024,
  applyIntents: 50,
  hydrateRefs: 200,
  createsPerApply: 20,
  dateWindowDays: 365,
} as const;

const str = (max: number = LIMITS.stringChars) => z.string().max(max);
const label = str(200);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Opaque Jarvis refs the model copies from CONTEXT. Resolved server-side; never trusted for titles. */
export const TODO_REF = /^todo:[A-Za-z0-9_.:@=+/-]{1,300}$/;
export const ITEM_REF = /^item:[A-Za-z0-9_-]{1,80}$/;
export const todoRef = z.string().regex(TODO_REF, "Unknown todo ref");
export const itemRef = z.string().regex(ITEM_REF, "Unknown item ref");
export const anyRef = z.union([todoRef, itemRef]);
/** `pr:owner/repo#123`: hydrated from GitHub (checks, reviews, readiness); only PRs linked to your own items resolve. */
export const PR_REF = /^pr:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#\d{1,9}$/;
export const prRef = z.string().regex(PR_REF, "Unknown PR ref");
/** Jarvis-computed numbers (spec §12a): the model names a metric, Jarvis supplies the value. Finance has none. */
export const METRICS = ["ai_spend_today", "ai_spend_7d", "items_done_14d", "overdue_count"] as const;
export type MetricId = (typeof METRICS)[number];
export const metricRef = z.enum(METRICS.map((m) => `metric:${m}`) as [`metric:${MetricId}`, ...`metric:${MetricId}`[]]);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const SUGGESTIONS = ["do_week", "reschedule", "drop", "snooze", "keep", "done"] as const;
export type Suggestion = (typeof SUGGESTIONS)[number];
/** Per-row quick actions a TaskList may offer. */
export const ROW_ACTIONS = ["done", "week", "snooze", "drop", "promote"] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

const STATUS_FOR_AI = ["captured", "exploring", "ready", "in_progress", "in_review", "awaiting_validation", "on_hold", "abandoned"] as const;

/** Intents a component can carry inline (DecisionCard options). Same shapes as lib/jarvis-ui/intents.ts. */
export const inlineIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("todo.complete"), ref: todoRef }).strict(),
  z.object({ kind: z.literal("todo.snooze"), ref: todoRef, date: dateStr }).strict(),
  z.object({ kind: z.literal("todo.drop"), ref: todoRef, note: str(300).optional() }).strict(),
  z.object({ kind: z.literal("todo.promote"), ref: todoRef, parentRef: itemRef }).strict(),
  z
    .object({
      kind: z.literal("item.update"),
      ref: itemRef,
      patch: z
        .object({ status: z.enum(STATUS_FOR_AI).optional(), nextAction: str(500).optional(), targetDate: dateStr.nullable().optional() })
        .strict()
        .refine((p) => Object.keys(p).length > 0, "Empty patch"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("item.create"),
      parentRef: itemRef,
      title: str(200).min(1),
      itemKind: z.enum(["project", "thread", "investigation", "note"]).optional(),
      nextAction: str(500).optional(),
      targetDate: dateStr.optional(),
    })
    .strict(),
]);
export type InlineIntent = z.infer<typeof inlineIntentSchema>;

/**
 * External writes (spec §4.3 `calendar.block`): staged like any intent but
 * applied only through their own approval with readback, and only when the
 * person turned calendar writes on. The event title always comes from the
 * hydrated ref, never from the client or the model.
 */
export const externalIntentSchema = z
  .object({ kind: z.literal("calendar.block"), ref: anyRef, date: dateStr, start: hhmm, minutes: z.number().int().min(15).max(480) })
  .strict();
export type ExternalIntent = z.infer<typeof externalIntentSchema>;

export const COMPONENTS = {
  Stack: z.object({ direction: z.enum(["column", "row"]).optional(), gap: z.enum(["sm", "md"]).optional() }).strict(),
  Section: z.object({ title: label, subtitle: label.optional(), tone: z.enum(["neutral", "warn", "ok", "accent"]).optional() }).strict(),
  Text: z.object({ text: str(), variant: z.enum(["body", "meta", "lead"]).optional() }).strict(),
  Callout: z.object({ tone: z.enum(["info", "warn", "ok"]), title: label, text: str().optional() }).strict(),
  Divider: z.object({}).strict(),
  TaskList: z
    .object({
      title: label,
      bucket: z.enum(SUGGESTIONS).optional(),
      /** "Promote" files the todo as a work item under this parent */
      promoteParentRef: itemRef.optional(),
      actions: z.array(z.enum(ROW_ACTIONS)).max(ROW_ACTIONS.length).optional(),
      rows: z
        .array(
          z
            .object({
              ref: anyRef,
              reason: str(300).optional(),
              suggestion: z.enum(SUGGESTIONS).optional(),
              suggestedDate: dateStr.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(LIMITS.listRows),
    })
    .strict(),
  DecisionCard: z
    .object({
      title: label,
      context: str(1000).optional(),
      options: z
        .array(
          z
            .object({
              id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
              label,
              consequence: str(300).optional(),
              recommended: z.boolean().optional(),
              intent: inlineIntentSchema.optional(),
            })
            .strict(),
        )
        .min(2)
        .max(6),
    })
    .strict(),
  Checklist: z
    .object({
      title: label,
      steps: z
        .array(
          z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/), label, detail: str(300).optional(), runBy: z.enum(["you", "agent"]).optional() }).strict(),
        )
        .min(1)
        .max(30),
    })
    .strict(),
  /** Static (model estimate, labelled as such) or `{metric}` (Jarvis-computed, live). */
  Gauge: z.union([
    z.object({ metric: metricRef, label: label.optional() }).strict(),
    z.object({ label, value: z.number().finite().min(0), max: z.number().finite().positive(), unit: str(12).optional(), note: str(200).optional() }).strict(),
  ]),
  /** A trend line: values only ever come from a `metric:` series. */
  Sparkline: z.object({ metric: metricRef, label: label.optional() }).strict(),
  /** Daily brief rows: Today / Snooze / Skip chips per row. Today and Snooze stage a date; Skip only hides the row here. */
  ApprovalChips: z
    .object({
      title: label,
      rows: z
        .array(z.object({ ref: anyRef, reason: str(300).optional() }).strict())
        .min(1)
        .max(20),
    })
    .strict(),
  /** Time blocks for one week. Dragging a block to another day stages a date; fixed calendar events are hydrated and read-only. */
  WeekPlan: z
    .object({
      title: label.optional(),
      /** the Monday the plan starts on */
      weekOf: dateStr,
      days: z.union([z.literal(5), z.literal(7)]).optional(),
      blocks: z
        .array(z.object({ ref: anyRef, day: dateStr.nullable(), start: hhmm.optional(), minutes: z.number().int().min(15).max(480) }).strict())
        .min(1)
        .max(30),
    })
    .strict(),
  /** One pull request: checks, reviews and readiness hydrated from GitHub. Merge stays on GitHub. */
  PRCard: z.object({ ref: prRef }).strict(),
  Table: z
    .object({
      columns: z
        .array(z.object({ key: z.string().regex(/^[a-zA-Z0-9_]{1,30}$/), label, align: z.enum(["left", "right"]).optional() }).strict())
        .min(1)
        .max(8),
      rows: z.array(z.object({ ref: anyRef.optional(), cells: z.record(z.string(), z.union([str(300), z.number()])) }).strict()).max(LIMITS.tableRows),
    })
    .strict(),
  ItemRef: z.object({ ref: anyRef }).strict(),
} as const;

export type ComponentName = keyof typeof COMPONENTS;
export const COMPONENT_NAMES = Object.keys(COMPONENTS) as ComponentName[];
/** Components that may hold children. */
export const CONTAINERS: ReadonlySet<ComponentName> = new Set(["Stack", "Section"]);
export type PropsOf<N extends ComponentName> = z.infer<(typeof COMPONENTS)[N]>;

export type UIElement = { type: ComponentName; props: Record<string, unknown>; children?: string[] };
export type JarvisSpec = { v: 1; catalog: typeof CATALOG_ID; root: string; elements: Record<string, UIElement> };

/** One-line summaries used by the prompt and docs. */
export const COMPONENT_DOCS: Record<ComponentName, string> = {
  Stack: "{direction?: column|row, gap?: sm|md} + children",
  Section: "{title, subtitle?, tone?: neutral|warn|ok|accent} + children",
  Text: "{text, variant?: body|meta|lead} plain text, **bold** and `code` only",
  Callout: "{tone: info|warn|ok, title, text?}",
  Divider: "{}",
  TaskList:
    "{title, bucket?, actions?: [done|week|snooze|drop|promote], promoteParentRef?: item ref, rows:[{ref, reason?, suggestion?: do_week|reschedule|drop|snooze|keep|done, suggestedDate?: YYYY-MM-DD}]} rows show live title/due from the ref",
  DecisionCard: "{title, context?, options:[{id, label, consequence?, recommended?, intent?}]} one choice; the chosen option's intent is staged",
  Checklist: "{title, steps:[{id, label, detail?, runBy?: you|agent}]} ticks are recorded, never run",
  Gauge: "{metric} live Jarvis number, or {label, value, max, unit?, note?} as your estimate",
  Sparkline: "{metric, label?} trend from a Jarvis series",
  ApprovalChips: "{title, rows:[{ref, reason?}]} brief rows: Today/Snooze/Skip",
  WeekPlan: "{weekOf: Monday, days?: 5|7, blocks:[{ref, day: YYYY-MM-DD|null, start?: HH:MM, minutes}]} Jarvis adds calendar events",
  PRCard: "{ref: pr:owner/repo#n} checks/reviews from GitHub",
  Table: "{columns:[{key,label,align?}], rows:[{ref?, cells:{key: text|number}}]} read-only, ≤50 rows",
  ItemRef: "{ref} inline chip",
};
