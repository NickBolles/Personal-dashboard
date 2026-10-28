import { z } from "zod";
import { addDays, daysBetween } from "@/lib/time";
import { inlineIntentSchema, LIMITS, ROW_ACTIONS, type InlineIntent, type JarvisSpec, type PropsOf, type RowAction } from "./catalog";
import { canonicalJson } from "./validator";

/**
 * The action allowlist (spec §4.3, slice 1). An intent is only a proposal: it
 * is staged in the surface's change tray and written by POST /api/smart/apply
 * after the person taps Apply. The server re-checks every intent with
 * `intentInSpec` against the stored spec, so a forged call can't apply
 * anything the surface never offered. There is no delete, settle or merge
 * intent, and none will be added (owner decisions D2/D3).
 */
export const intentSchema = inlineIntentSchema;
export type Intent = InlineIntent;
export type IntentKind = Intent["kind"];

export const applyBodySchema = z
  .object({
    surfaceId: z.string().regex(/^uis_[A-Za-z0-9_-]{6,60}$/),
    intents: z.array(z.unknown()).min(1).max(LIMITS.applyIntents),
    idempotencyKey: z.string().min(8).max(120),
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
  return intent.kind === "item.create" ? `new:${intent.parentRef}:${intent.title}` : intent.ref;
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
  const key = intentKey(intent);
  for (const el of Object.values(spec.elements)) {
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
  }
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
  }
}
