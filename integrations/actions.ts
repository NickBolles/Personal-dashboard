import type { ActionSource, NextAction, PriorityReason } from "@/lib/contracts";
import { classifyDue } from "@/server/ranking";
import { iso, localTimeToInstant, MINUTE } from "@/lib/time";
import type { AdapterContext } from "./types";

export function actionId(source: ActionSource, sourceId: string) {
  return `${source}:${sourceId}`;
}

/** Date-only due dates (Google Tasks, many todo apps) are due by end of that local day. */
export function classifyDateOnly(date: string, ctx: AdapterContext): { reason: PriorityReason; dueAt: string } {
  const dueAt = new Date(localTimeToInstant(date, "00:00", ctx.timezone).getTime() + 24 * 60 * MINUTE - MINUTE);
  if (date < ctx.today) return { reason: "overdue", dueAt: iso(dueAt) };
  if (date === ctx.today) return { reason: "today", dueAt: iso(dueAt) };
  return { reason: "upcoming", dueAt: iso(dueAt) };
}

export function classifyInstant(dueAt: string | undefined, ctx: AdapterContext) {
  return classifyDue({ dueAt, now: ctx.now, endOfToday: ctx.endOfToday });
}

export function baseAction(
  source: ActionSource,
  sourceId: string,
  ctx: AdapterContext,
  staleAfterMs: number,
  rest: Omit<NextAction, "id" | "source" | "sourceId" | "fetchedAt" | "staleAfter">,
): NextAction {
  return {
    id: actionId(source, sourceId),
    source,
    sourceId,
    fetchedAt: iso(ctx.now),
    staleAfter: iso(ctx.now.getTime() + staleAfterMs),
    ...rest,
  };
}
