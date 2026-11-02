/**
 * Inline (tap-to-edit) field edits for work items: pure validation and the
 * optimistic/rollback reducer the rows and the item detail share. Settling is
 * never offered inline: it stays the deliberate Settle… dialog.
 */
import { STATUS_LABELS, type WorkStatus } from "./work";

export type InlineField = "title" | "nextAction" | "summary" | "status" | "targetDate";
export type InlineValues = { title: string; nextAction: string; summary: string; status: WorkStatus; targetDate: string | null };

/** Statuses the inline select offers; settled/ready_to_settle/superseded/abandoned need their own flows. */
export const INLINE_STATUSES: WorkStatus[] = ["captured", "exploring", "ready", "in_progress", "in_review", "awaiting_validation", "on_hold", "reopened"];

/** Options for an item's inline status select: the allowed set, plus its current status (shown, not re-selectable as a change). */
export function inlineStatusOptions(current: WorkStatus): { value: WorkStatus; label: string; disabled?: boolean }[] {
  const opts: { value: WorkStatus; label: string; disabled?: boolean }[] = INLINE_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }));
  if (!INLINE_STATUSES.includes(current)) opts.unshift({ value: current, label: STATUS_LABELS[current], disabled: true });
  return opts;
}

export const INLINE_LIMITS: Record<Exclude<InlineField, "status" | "targetDate">, number> = { title: 200, nextAction: 2000, summary: 20_000 };

export type InlineCheck<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates and normalises one inline edit. `unchanged` edits are reported as ok with `same`. */
export function validateInline(field: InlineField, raw: string, ctx: { status?: WorkStatus } = {}): InlineCheck<string | null> {
  if (field === "status") {
    if (!INLINE_STATUSES.includes(raw as WorkStatus)) return { ok: false, error: "Settle from the Settle… action, not inline" };
    return { ok: true, value: raw };
  }
  if (field === "targetDate") {
    const v = raw.trim();
    if (!v) return { ok: true, value: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return { ok: false, error: "Use a date like 2026-11-30" };
    return { ok: true, value: v };
  }
  const v = field === "summary" ? raw.replace(/\s+$/, "") : raw.trim().replace(/\s+/g, " ");
  if (field === "title" && !v) return { ok: false, error: "A title can't be empty" };
  if (field === "nextAction" && !v && (ctx.status === "ready" || ctx.status === "in_progress"))
    return { ok: false, error: "Ready and in-progress work needs a next action" };
  if (v.length > INLINE_LIMITS[field]) return { ok: false, error: `Keep it under ${INLINE_LIMITS[field]} characters` };
  return { ok: true, value: v };
}

/** Optimistic state per item: pending overrides on top of server values, rolled back on error. */
export type InlineState = Record<string, { pending: Partial<InlineValues>; prev: Partial<InlineValues> }>;
export type InlineAction =
  | { type: "begin"; id: string; field: InlineField; value: InlineValues[InlineField]; prev: InlineValues[InlineField] }
  | { type: "commit"; id: string; field: InlineField }
  | { type: "rollback"; id: string; field: InlineField };

export function inlineReducer(state: InlineState, a: InlineAction): InlineState {
  const cur = state[a.id] ?? { pending: {}, prev: {} };
  if (a.type === "begin") {
    const prev = a.field in cur.prev ? cur.prev : { ...cur.prev, [a.field]: a.prev };
    return { ...state, [a.id]: { pending: { ...cur.pending, [a.field]: a.value }, prev } };
  }
  if (!(a.field in cur.pending)) return state;
  const pending = { ...cur.pending };
  const prev = { ...cur.prev };
  delete pending[a.field];
  delete prev[a.field];
  const next = { ...state };
  if (Object.keys(pending).length) next[a.id] = { pending, prev };
  else delete next[a.id];
  return next;
}

/** Server values with the pending optimistic overrides applied. */
export function withPending<T extends Partial<InlineValues> & { id: string }>(item: T, state: InlineState): T {
  const p = state[item.id]?.pending;
  return p ? { ...item, ...p } : item;
}

export const INLINE_LABELS: Record<InlineField, string> = {
  title: "Title",
  nextAction: "Next action",
  summary: "Summary",
  status: "Status",
  targetDate: "Due date",
};
