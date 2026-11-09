import type { Decision } from "@/lib/cw-decisions";

export type DecisionRef = Pick<Decision, "ref">;
export type PagerState = { index: number; total: number; prev: string | null; next: string | null };

/** Zero-based index, non-wrapping neighbours; a missing ref has index -1. */
export function pagerState(list: readonly DecisionRef[], ref: string): PagerState {
  const index = list.findIndex((d) => d.ref === ref);
  return { index, total: list.length, prev: index > 0 ? list[index - 1].ref : null, next: index >= 0 ? (list[index + 1]?.ref ?? null) : null };
}

/** Prefer the next row, then the preceding row, never the answered row itself. */
export function nextAfterAnswer(list: readonly DecisionRef[], answeredRef: string): string | null {
  const { index, next, prev } = pagerState(list, answeredRef);
  return index < 0 ? (list[0]?.ref ?? null) : (next ?? prev);
}

export type NeedsNow = Date | number;
const timestamp = (now: NeedsNow) => (now instanceof Date ? now.getTime() : now);
function durationLabel(ms: number, round: (n: number) => number): string {
  if (ms >= 86_400_000) return `${round(ms / 86_400_000)} d`;
  if (ms >= 3_600_000) return `${round(ms / 3_600_000)} h`;
  return `${Math.max(1, round(ms / 60_000))} min`;
}
export function ageLabel(createdAt: string, now: NeedsNow): string {
  const ms = timestamp(now) - Date.parse(createdAt);
  return Number.isFinite(ms) ? durationLabel(Math.max(0, ms), Math.floor) : "Unknown age";
}
export const isRisky = (d: Pick<Decision, "risk">): boolean => d.risk.length > 0;
export function recommendedChoice(d: Pick<Decision, "recommended" | "choices">): string | null {
  return d.recommended && d.choices.includes(d.recommended) ? d.recommended : (d.choices[0] ?? null);
}
export function defaultLine(d: Pick<Decision, "risk" | "defaultChoice" | "expiresAt">, now: NeedsNow): string | null {
  if (isRisky(d) || !d.defaultChoice || !d.expiresAt) return null;
  const ms = Date.parse(d.expiresAt) - timestamp(now);
  if (!Number.isFinite(ms)) return null;
  return ms > 0 ? `Defaults to ${d.defaultChoice} in ${durationLabel(ms, Math.ceil)}` : `Defaults to ${d.defaultChoice} now`;
}

export type DecisionKeyContext = { typing?: boolean; armed?: boolean; canUndo?: boolean };
export type DecisionKeyAction = "next" | "prev" | "pick-1" | "pick-2" | "pick-3" | "pick-4" | "confirm" | "back" | "defer" | "ask" | "undo";
export function decisionKeyAction(key: string, ctx: DecisionKeyContext): DecisionKeyAction | null {
  if (ctx.typing) return null;
  if (key === "Enter") return ctx.armed ? "confirm" : null;
  if (key === "u") return ctx.canUndo ? "undo" : null;
  const actions: Record<string, DecisionKeyAction> = {
    j: "next",
    k: "prev",
    "1": "pick-1",
    "2": "pick-2",
    "3": "pick-3",
    "4": "pick-4",
    Escape: "back",
    Esc: "back",
    d: "defer",
    a: "ask",
  };
  return actions[key] ?? null;
}

/** Tomorrow at 09:00 in the owner's browser-local timezone (including DST). */
export function deferUntil(kind: "hour" | "tomorrow", now = new Date()): string {
  if (kind === "hour") return new Date(now.getTime() + 3_600_000).toISOString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

/** Mirror the server allowlist, with a URL parse as defence against malformed https links. */
export function safeEvidenceHref(value?: string): string | null {
  if (!value) return null;
  if (/^\/(?![/\\])[^\s\\]*$/.test(value)) return value;
  if (!/^https:\/\/[^\s\\]+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}
