"use client";

import type { ReactNode } from "react";
import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { localDate } from "@/lib/time";
import { ActionCard } from "@/components/actions/ActionCard";
import { CalendarIcon, CheckIcon, PeopleIcon } from "@/components/icons";
import { IconAction } from "@/components/ui/IconAction";
import { cx } from "@/components/ui/kit";
import { useNow, useOnline } from "@/components/ui";
import { dueState } from "./grouping";
import { choreWrite, listWrite, rescheduleWrite } from "./model";

const SkipGlyph = () => (
  <svg
    aria-hidden="true"
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m5 5 9 7-9 7V5ZM18 5v14" />
  </svg>
);
const ReopenGlyph = () => (
  <svg
    aria-hidden="true"
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 10h11a5 5 0 0 1 0 10h-4" />
    <path d="m8 6-4 4 4 4" />
  </svg>
);

export type ChoreSuggestion = { key: "complete" | "skip" | "reschedule" | "claim" | "reopen"; label: string; tip: string; op: SkylightWriteOp };

/**
 * Suggested actions for a chore row (the first one is the row's single primary):
 * overdue → Do now (mark done) · Skip · Move to today (one-off chores only); up for grabs → Claim; done → Reopen.
 * Every write still goes through the confirm card and can be undone.
 */
export function choreSuggestions(action: NextAction, opts: { now: number; timezone: string }): ChoreSuggestion[] {
  const ref = action.skylight;
  if (ref?.kind !== "chore") return [];
  if (action.status === "completed") {
    const reopen = choreWrite(action, "chore.reopen");
    return reopen ? [{ key: "reopen", label: `Reopen: ${action.title}`, tip: "Reopen", op: reopen }] : [];
  }
  if (action.status !== "open") return [];
  const out: ChoreSuggestion[] = [];
  if (dueState(action, opts) === "overdue") {
    const complete = choreWrite(action, "chore.complete");
    const skip = choreWrite(action, "chore.skip");
    const move = rescheduleWrite(action, localDate(opts.now, opts.timezone));
    if (complete) out.push({ key: "complete", label: `Do now: ${action.title}`, tip: "Do now — mark done", op: complete });
    if (skip) out.push({ key: "skip", label: `Skip: ${action.title}`, tip: "Skip this one", op: skip });
    if (move) out.push({ key: "reschedule", label: `Move to today: ${action.title}`, tip: "Move to today", op: move });
  }
  if (action.assignee?.kind === "up_for_grabs" && !ref.recurring)
    out.push({
      key: "claim",
      label: `Claim: ${action.title}`,
      tip: "Claim — assign it to you",
      op: { op: "chore.claim", choreId: ref.choreId, title: action.title, fromCategoryId: ref.categoryId ?? null },
    });
  return out;
}

const ICON: Record<ChoreSuggestion["key"], ReactNode> = {
  complete: <CheckIcon className="h-4 w-4" />,
  skip: <SkipGlyph />,
  reschedule: <CalendarIcon className="h-4 w-4" />,
  claim: <PeopleIcon className="h-4 w-4" />,
  reopen: <ReopenGlyph />,
};

/** Skylight never falls through to the generic /api/actions completion endpoint. */
export function SkylightActionRow({
  action,
  writable,
  request,
  timezone = "America/Chicago",
}: {
  action: NextAction;
  writable: boolean;
  request: (op: SkylightWriteOp) => void;
  /** Kept for callers; suggested actions show on the Skylight page and in Todos alike. */
  management?: boolean;
  timezone?: string;
}) {
  const online = useOnline();
  const now = useNow();
  const ref = action.skylight;
  const completed = action.status === "completed";
  const complete = writable && !completed ? choreWrite(action, "chore.complete") : null;
  const check = writable ? listWrite(action) : null;
  const tone = dueState(action, { now, timezone });
  const suggestions = writable ? choreSuggestions(action, { now, timezone }) : [];
  return (
    <ActionCard
      action={{
        ...action,
        sourceLabel: ref?.kind === "list_item" ? action.sourceLabel || `Skylight · ${ref.listLabel}` : action.sourceLabel,
        detail: action.detail || action.assignee?.name,
        primaryAction: undefined,
        secondaryActions: action.secondaryActions?.filter((kind) => kind !== "complete"),
      }}
      row
      quiet
      compact={completed}
      dueTone={tone === "overdue" ? "danger" : tone === "late" ? "warn" : undefined}
      showSource={ref?.kind === "list_item"}
      onComplete={complete ? () => request(complete) : undefined}
      leading={
        check ? (
          <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center sm:min-h-9 sm:min-w-9 dense:min-h-[30px] dense:min-w-[30px]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              aria-label={action.title}
              checked={completed}
              disabled={!online}
              onChange={() => request(check)}
            />
          </label>
        ) : undefined
      }
      trailing={
        suggestions.length ? (
          <div
            role="group"
            aria-label={`Suggested actions for ${action.title}`}
            className={cx(
              "flex shrink-0 flex-wrap items-center gap-1",
              // Phones: 2+ icons get their own line under the title (the row wraps) so the title never collapses.
              suggestions.length > 1 && "max-sm:order-last max-sm:basis-full max-sm:justify-end",
            )}
          >
            {suggestions.map((s, i) => (
              <IconAction
                key={s.key}
                label={s.label}
                title={s.tip}
                icon={ICON[s.key]}
                tone={i === 0 ? "primary" : "default"}
                disabled={!online}
                onClick={() => request(s.op)}
              />
            ))}
          </div>
        ) : undefined
      }
    />
  );
}
