"use client";

import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { ActionCard } from "@/components/actions/ActionCard";
import { Button, useOnline } from "@/components/ui";
import { choreWrite, listWrite } from "./model";

/** Skylight never falls through to the generic /api/actions completion endpoint. */
export function SkylightActionRow({
  action,
  writable,
  request,
  management = false,
}: {
  action: NextAction;
  writable: boolean;
  request: (op: SkylightWriteOp) => void;
  management?: boolean;
}) {
  const online = useOnline();
  const ref = action.skylight;
  const completed = action.status === "completed";
  const complete = writable && !completed ? choreWrite(action, "chore.complete") : null;
  const reopen = writable && completed ? choreWrite(action, "chore.reopen") : null;
  const check = writable ? listWrite(action) : null;
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
        management && writable && ref?.kind === "chore" ? (
          <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
            {reopen ? (
              <Button type="button" size="sm" disabled={!online} aria-label={`Reopen: ${action.title}`} onClick={() => request(reopen)}>
                Reopen
              </Button>
            ) : null}
            {!completed && action.assignee?.kind === "up_for_grabs" && !ref.recurring ? (
              <Button
                type="button"
                size="sm"
                disabled={!online}
                aria-label={`Claim: ${action.title}`}
                onClick={() => request({ op: "chore.claim", choreId: ref.choreId, title: action.title, fromCategoryId: ref.categoryId ?? null })}
              >
                Claim
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}
