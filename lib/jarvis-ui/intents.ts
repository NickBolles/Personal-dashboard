import { z } from "zod";
import { addDays, daysBetween } from "@/lib/time";
import {
  externalIntentSchema,
  inlineIntentSchema,
  LIMITS,
  ROW_ACTIONS,
  type ExternalIntent,
  type InlineIntent,
  type JarvisSpec,
  type PropsOf,
  type RowAction,
} from "./catalog";
import { canonicalJson } from "./validator";

/**
 * The action allowlist (spec §4.3, slice 1). An intent is only a proposal: it
 * is staged in the surface's change tray and written by POST /api/smart/apply
 * after the person taps Apply. The server re-checks every intent with
 * `intentInSpec` against the stored spec, so a forged call can't apply
 * anything the surface never offered. There is no delete, settle or merge
 * intent, and none will be added (owner decisions D2/D3).
 */
export const intentSchema = z.discriminatedUnion("kind", [...inlineIntentSchema.options, externalIntentSchema]);
export type Intent = InlineIntent | ExternalIntent;

/** External writes never go out with the ordinary Apply: they need their own approval. */
export function isExternal(intent: Intent): intent is ExternalIntent {
  return intent.kind === "calendar.block";
}
export type IntentKind = Intent["kind"];

export const applyBodySchema = z
  .object({
    surfaceId: z.string().regex(/^uis_[A-Za-z0-9_-]{6,60}$/),
    intents: z.array(z.unknown()).min(1).max(LIMITS.applyIntents),
    idempotencyKey: z.string().min(8).max(120),
    /** set by the separate external-write approval (calendar); the batch must then hold only external intents */
    external: z.literal(true).optional(),
  })
  .strict();

export const undoBodySchema = z
  .object({ surfaceId: z.string().regex(/^uis_[A-Za-z0-9_-]{6,60}$/), intentHash: z.string().regex(/^[a-f0-9]{16,64}$/) })
  .strict();

export const DEFAULT_ROW_ACTIONS: RowAction[] = ["done", "week", "snooze", "drop"];

/** Stable identity of an intent (same intent → same key) — server hashes it. */
export function intentKey(intent: Intent) {
  return canonicalJson(intent);
}

/** The ref a staged intent is about (one staged change per ref per surface). */
export function intentTarget(intent: Intent): string {
  if (intent.kind === "item.create") return `new:${intent.parentRef}:${intent.title}`;
  // A calendar block is a second, separate change for the same ref (its date move stays staged too).
  if (intent.kind === "calendar.block") return `cal:${intent.ref}`;
  return intent.ref;
}

// --- daily brief (ApprovalChips) and week plan (WeekPlan) ---

export const BRIEF_CHOICES = ["today", "snooze", "skip"] as const;
export type BriefChoice = (typeof BRIEF_CHOICES)[number];

/**
 * The write a brief chip stages: "Today" moves the todo/item to today,
 * "Snooze" to tomorrow. "Skip" writes nothing (it only hides the row on this
 * surface), so it has no intent. `due` is the hydrated date.
 */
export function chipIntent(ref: string, choice: BriefChoice, today: string, due?: string): Intent | undefined {
  if (choice === "skip") return undefined;
  const date = choice === "today" ? today : addDays(today, 1);
  if (due === date) return undefined;
  return ref.startsWith("item:") ? { kind: "item.update", ref, patch: { targetDate: date } } : { kind: "todo.snooze", ref, date };
}

/** The dates a week plan covers (Mon…Fri, or Mon…Sun). */
export function weekDays(weekOf: string, days: 5 | 7 = 5): string[] {
  return Array.from({ length: days }, (_, i) => addDays(weekOf, i));
}

/** The Monday of `today`'s week; on Sat/Sun the coming Monday (plan next week). */
export function planWeekOf(today: string) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (dow === 6) return addDays(today, 2);
  if (dow === 0) return addDays(today, 1);
  return addDays(today, 1 - dow);
}

/** Moving a block to another day stages that day as the todo's due / the item's target date. */
export function blockMoveIntent(ref: string, day: string): Intent {
  return ref.startsWith("item:") ? { kind: "item.update", ref, patch: { targetDate: day } } : { kind: "todo.snooze", ref, date: day };
}

export const DAY_START = "07:00";
export const DAY_END = "21:00";
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A block fits the planner grid: on a quarter hour, inside 07:00–21:00. */
export function blockFits(start: string, minutes: number) {
  const s = mins(start);
  return s % 15 === 0 && s >= mins(DAY_START) && s + minutes <= mins(DAY_END);
}

function inWindow(date: string, today: string) {
  const d = daysBetween(today, date);
  return Number.isFinite(d) && d >= 0 && d <= LIMITS.dateWindowDays;
}

/** "This week" = the coming Friday (today on Fri–Sun). */
export function thisWeekDate(today: string) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return dow >= 5 || dow === 0 ? today : addDays(today, 5 - dow);
}

type Row = PropsOf<"TaskList">["rows"][number];

function rowActions(list: PropsOf<"TaskList">): Set<RowAction> {
  const a = new Set<RowAction>(list.actions?.length ? list.actions : DEFAULT_ROW_ACTIONS);
  if (!list.promoteParentRef) a.delete("promote");
  return a;
}

/** Actions this row offers, in display order (todo vs item refs differ). */
export function actionsForRow(list: PropsOf<"TaskList">, row: Row): RowAction[] {
  const a = rowActions(list);
  const isItem = row.ref.startsWith("item:");
  return ROW_ACTIONS.filter((x) => a.has(x) && !(isItem && (x === "done" || x === "promote")));
}

/** Build the intent a row action stages. `date` overrides the default date for week/snooze. */
export function rowIntent(list: PropsOf<"TaskList">, row: Row, action: RowAction, today: string, date?: string): Intent | undefined {
  const isItem = row.ref.startsWith("item:");
  const when =
    date ??
    (action === "week"
      ? row.suggestion === "do_week" && row.suggestedDate
        ? row.suggestedDate
        : thisWeekDate(today)
      : (row.suggestedDate ?? addDays(today, 7)));
  if (isItem) {
    if (action === "week" || action === "snooze") return { kind: "item.update", ref: row.ref, patch: { targetDate: when } };
    if (action === "drop") return { kind: "item.update", ref: row.ref, patch: { status: "abandoned" } };
    return undefined;
  }
  switch (action) {
    case "done":
      return { kind: "todo.complete", ref: row.ref };
    case "week":
    case "snooze":
      return { kind: "todo.snooze", ref: row.ref, date: when };
    case "drop":
      return { kind: "todo.drop", ref: row.ref, ...(row.reason ? { note: row.reason.slice(0, 300) } : {}) };
    case "promote":
      return list.promoteParentRef ? { kind: "todo.promote", ref: row.ref, parentRef: list.promoteParentRef } : undefined;
  }
}

/** The row's suggestion as an action ("Apply suggestion"). */
export function suggestedAction(row: Row): RowAction | undefined {
  switch (row.suggestion) {
    case "do_week":
      return "week";
    case "reschedule":
    case "snooze":
      return "snooze";
    case "drop":
      return "drop";
    case "done":
      return "done";
    default:
      return undefined;
  }
}

/**
 * Server-side binding check: does the stored spec offer this intent (exactly,
 * or within the bounds it declares)? Pure; `today` is the household's local date.
 */
export function intentInSpec(spec: JarvisSpec, intent: Intent, today: string): boolean {
  // Date bounds hold whichever component offered the intent (a model-written option included).
  const dates = [
    intent.kind === "todo.snooze" ? intent.date : undefined,
    intent.kind === "item.update" ? (intent.patch.targetDate ?? undefined) : undefined,
    intent.kind === "item.create" ? intent.targetDate : undefined,
  ].filter((d): d is string => Boolean(d));
  if (dates.some((d) => !inWindow(d, today))) return false;
  if (intent.kind === "calendar.block" && !inWindow(intent.date, today)) return false;
  const key = intentKey(intent);
  const ref = "ref" in intent ? intent.ref : undefined;
  const dateOf = intent.kind === "todo.snooze" ? intent.date : intent.kind === "item.update" ? intent.patch.targetDate : undefined;
  const onlyTargetDate = intent.kind === "item.update" && Object.keys(intent.patch).length === 1 && Boolean(intent.patch.targetDate);
  const isMove = (intent.kind === "todo.snooze" && ref?.startsWith("todo:")) || (onlyTargetDate && ref?.startsWith("item:"));
  for (const el of Object.values(spec.elements)) {
    if (el.type === "ApprovalChips") {
      const p = el.props as PropsOf<"ApprovalChips">;
      if (isMove && p.rows.some((r) => r.ref === ref) && (dateOf === today || dateOf === addDays(today, 1))) return true;
      continue;
    }
    if (el.type === "WeekPlan") {
      const p = el.props as PropsOf<"WeekPlan">;
      const days = weekDays(p.weekOf, p.days ?? 5).filter((d) => d >= today);
      if (!p.blocks.some((b) => b.ref === ref)) continue;
      if (isMove && dateOf && days.includes(dateOf)) return true;
      if (intent.kind === "calendar.block" && days.includes(intent.date) && blockFits(intent.start, intent.minutes)) return true;
      continue;
    }
    if (el.type === "DecisionCard") {
      const p = el.props as PropsOf<"DecisionCard">;
      if (p.options.some((o) => o.intent && intentKey(o.intent) === key)) return true;
    }
    if (el.type !== "TaskList") continue;
    const list = el.props as PropsOf<"TaskList">;
    const allowed = rowActions(list);
    for (const row of list.rows) {
      if (row.ref !== ("ref" in intent ? intent.ref : undefined)) continue;
      const sug = suggestedAction(row);
      const offers = (a: RowAction) => allowed.has(a) || sug === a;
      const isItem = row.ref.startsWith("item:");
      switch (intent.kind) {
        case "todo.complete":
          if (!isItem && offers("done")) return true;
          break;
        case "todo.snooze":
          if (!isItem && (offers("week") || offers("snooze")) && inWindow(intent.date, today)) return true;
          break;
        case "todo.drop":
          if (!isItem && offers("drop")) return true;
          break;
        case "todo.promote":
          if (!isItem && allowed.has("promote") && intent.parentRef === list.promoteParentRef) return true;
          break;
        case "item.update": {
          if (!isItem) break;
          const keys = Object.keys(intent.patch);
          if (
            keys.length === 1 &&
            keys[0] === "targetDate" &&
            (offers("week") || offers("snooze")) &&
            intent.patch.targetDate &&
            inWindow(intent.patch.targetDate, today)
          )
            return true;
          if (keys.length === 1 && keys[0] === "status" && intent.patch.status === "abandoned" && offers("drop")) return true;
          break;
        }
      }
    }
  }
  return false;
}

function fmtDate(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Plain-language line for the tray review list. */
export function describeIntent(intent: Intent, titleOf: (ref: string) => string | undefined = () => undefined): string {
  const t = (ref: string) => titleOf(ref) ?? "this task";
  switch (intent.kind) {
    case "todo.complete":
      return `Mark “${t(intent.ref)}” done`;
    case "todo.snooze":
      return `Move “${t(intent.ref)}” to ${fmtDate(intent.date)}`;
    case "todo.drop":
      return `Drop “${t(intent.ref)}” (marked done with a dropped note)`;
    case "todo.promote":
      return `File “${t(intent.ref)}” as a work item under ${titleOf(intent.parentRef) ?? "the chosen item"}`;
    case "item.update": {
      const parts: string[] = [];
      if (intent.patch.targetDate !== undefined) parts.push(intent.patch.targetDate ? `target ${fmtDate(intent.patch.targetDate)}` : "clear target");
      if (intent.patch.status) parts.push(intent.patch.status === "abandoned" ? "drop (abandoned)" : `status ${intent.patch.status.replace(/_/g, " ")}`);
      if (intent.patch.nextAction !== undefined) parts.push(`next action “${intent.patch.nextAction.slice(0, 80)}”`);
      return `Update “${t(intent.ref)}”: ${parts.join(", ")}`;
    }
    case "item.create":
      return `Create “${intent.title}” under ${titleOf(intent.parentRef) ?? "the chosen item"}`;
    case "calendar.block":
      return `Add “${t(intent.ref)}” to the calendar on ${fmtDate(intent.date)} at ${intent.start} for ${fmtMinutes(intent.minutes)}`;
  }
}

export function fmtMinutes(m: number) {
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}

/** Short verb for a row's staged state ("Done", "→ Fri Oct 30", "Drop"). */
export function intentChip(intent: Intent): string {
  switch (intent.kind) {
    case "todo.complete":
      return "Done";
    case "todo.snooze":
      return `→ ${fmtDate(intent.date)}`;
    case "todo.drop":
      return "Drop";
    case "todo.promote":
      return "Promote";
    case "item.update":
      return intent.patch.status === "abandoned" ? "Drop" : intent.patch.targetDate ? `→ ${fmtDate(intent.patch.targetDate)}` : "Update";
    case "item.create":
      return "Create";
    case "calendar.block":
      return "Calendar";
  }
}
