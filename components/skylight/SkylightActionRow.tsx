"use client";

import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { localDate } from "@/lib/time";
import { ActionCard } from "@/components/actions/ActionCard";
import { CalendarIcon, PeopleIcon } from "@/components/icons";
import { Button, useNow, useOnline } from "@/components/ui";
import { dueTone } from "./grouping";
import { choreWrite, listWrite, rescheduleWrite } from "./model";

/** Skylight never falls through to the generic /api/actions completion endpoint. */
export function SkylightActionRow({
  action,
  writable,
  request,
  management = false,
  timezone = "America/Chicago",
}: {
  action: NextAction;
  writable: boolean;
  request: (op: SkylightWriteOp) => void;
  management?: boolean;
  timezone?: string;
}) {
  const online = useOnline();
  const now = new Date(useNow());
  const ref = action.skylight;
  const completed = action.status === "completed";
  const complete = writable && !completed ? choreWrite(action, "chore.complete") : null;
  const reopen = writable && completed ? choreWrite(action, "chore.reopen") : null;
  const check = writable ? listWrite(action) : null;
  const overdue = writable && action.status === "open" && action.priorityReason === "overdue";
  const skip = overdue ? choreWrite(action, "chore.skip") : null;
  const doToday = overdue ? rescheduleWrite(action, localDate(now, timezone)) : null;
  const claim = writable && action.status === "open" && ref?.kind === "chore" && action.assignee?.kind === "up_for_grabs" && !ref.recurring;
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
      dueTone={ref?.kind === "chore" ? dueTone(action, now) : undefined}
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
        writable && ref?.kind === "chore" && ((management && reopen) || doToday || skip || claim) ? (
          <div className="flex max-w-full flex-wrap items-center gap-1">
            {management && reopen ? (
              <Button type="button" size="sm" disabled={!online} aria-label={`Reopen: ${action.title}`} onClick={() => request(reopen)}>
                Reopen
              </Button>
            ) : null}
            {doToday ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-11 sm:min-w-9 dense:min-w-[30px]"
                disabled={!online}
                aria-label={`Do today: ${action.title}`}
                title="Do today"
                onClick={() => request(doToday)}
              >
                <CalendarIcon className="h-4 w-4" />
              </Button>
            ) : null}
            {skip ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-11 sm:min-w-9 dense:min-w-[30px]"
                disabled={!online}
                aria-label={`Skip: ${action.title}`}
                title="Skip"
                onClick={() => request(skip)}
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 4 11 8-11 8V4Zm14 0v16" />
                </svg>
              </Button>
            ) : null}
            {claim ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-11 sm:min-w-9 dense:min-w-[30px]"
                disabled={!online}
                aria-label={`Claim: ${action.title}`}
                title="Claim"
                onClick={() => request({ op: "chore.claim", choreId: ref.choreId, title: action.title, fromCategoryId: ref.categoryId ?? null })}
              >
                <PeopleIcon className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}
