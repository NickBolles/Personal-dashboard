import type { PropsOf } from "./catalog";
import type { InlineIntent } from "./catalog";
import type { TaskRef } from "./types";
import { addDays, daysBetween } from "@/lib/time";

export function matrixTotals(p: PropsOf<"DecisionMatrix">, weights: Record<string, number> = {}) {
  const totals = p.options.map((o) => ({
    id: o.id,
    total: p.criteria.reduce((n, c) => n + o.scores[c.id]! * Math.max(1, Math.min(3, weights[c.id] ?? c.weight)), 0),
  }));
  const max = Math.max(...totals.map((t) => t.total));
  return totals.map((t) => ({ ...t, recommended: t.total === max }));
}
export function matrixIntent(p: PropsOf<"DecisionMatrix">, option: PropsOf<"DecisionMatrix">["options"][number]): InlineIntent {
  return { kind: "item.update", ref: p.ref, patch: { nextAction: `Decided: ${option.label}` } };
}
export function ganttLayout(item: TaskRef, row: PropsOf<"Gantt">["rows"][number], from: string, to: string, today: string) {
  if (!item.due) return undefined;
  const end = item.due;
  const requestedStart = row.start ?? item.createdDate ?? addDays(end, -7);
  const start = requestedStart > end ? end : requestedStart;
  const span = Math.max(1, daysBetween(from, to) + 1);
  const left = Math.max(0, Math.min(100, (daysBetween(from, start) / span) * 100));
  const right = Math.max(left, Math.min(100, ((daysBetween(from, end) + 1) / span) * 100));
  return {
    start,
    end,
    left,
    width: right - left,
    milestone: row.milestone === true,
    tone: item.done ? "ok" : end < today ? "danger" : "accent",
    today: Math.max(0, Math.min(100, (daysBetween(from, today) / span) * 100)),
  };
}
export type FormValues = Record<string, string | boolean | number>;
// Browser module singleton: only the most recent surface's visible undo window owns Cmd/Ctrl+Z.
let latestUndo: string | undefined;
export function registerSmartUndo(token: string) {
  latestUndo = token;
}
export function isLatestSmartUndo(token: string) {
  return latestUndo === token;
}
export function formIntents(p: PropsOf<"Form">, values: FormValues): InlineIntent[] {
  const intents: InlineIntent[] = [];
  for (const c of p.submit.creates ?? []) {
    const parentRef = c.parentRef ?? String(values[c.parentField!] ?? "");
    if (!c.parentRef && !c.parentRefs?.includes(parentRef)) continue;
    const text = String(values[c.titleField] ?? "").trim();
    const titles = (c.splitLines ? text.split(/\n/).map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim()) : [text]).filter(Boolean).slice(0, c.maxItems ?? 1);
    for (const title of titles) if (title.length <= 200 && !/https?:\/\/|www\.|<[^>]*>/i.test(title)) intents.push({ kind: "item.create", parentRef, title });
  }
  return [...intents, ...(p.submit.updates ?? [])];
}
/** Native editing undo wins, including descendants of contenteditable. */
export function smartUndoKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  defaultPrevented?: boolean;
}) {
  const target = e.target as Element | null;
  return (
    !e.defaultPrevented &&
    e.key.toLowerCase() === "z" &&
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey &&
    !target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
  );
}
