"use client";
import { ChipButton } from "@/components/ui/kit";
import { cx } from "@/components/ui";
import { contextualActions, fillQuickAction, QUICK_ACTION_MANAGE, type QuickActionContext } from "@/lib/quick-actions";
import { useQuickActions } from "./useQuickActions";
import "./quick-actions.css";

export function QuickActionChips({
  onPrompt,
  context,
  variant,
}: {
  onPrompt: (text: string) => void;
  context: QuickActionContext;
  variant: "empty" | "row" | "tray";
}) {
  const query = useQuickActions();
  const actions = contextualActions(query.data?.actions ?? [], context);
  return (
    <div className="qa-root min-w-0" data-testid={`quick-actions-${variant}`}>
      <div role="group" className={cx("qa-chips", variant === "row" ? "qa-scroll" : "qa-wrap")} aria-label="Quick actions">
        {actions.map((a) => (
          <ChipButton
            key={a.id}
            className="qa-hit qa-chip"
            title="Fill the composer — nothing is sent"
            onClick={() => onPrompt(fillQuickAction(a.prompt, context))}
          >
            {fillQuickAction(a.label, context)}
          </ChipButton>
        ))}
        <ChipButton
          className="qa-hit shrink-0"
          aria-label="Manage quick actions"
          onClick={() => window.dispatchEvent(new CustomEvent(QUICK_ACTION_MANAGE, { detail: context }))}
        >
          ⋮
        </ChipButton>
      </div>
      {query.error ? (
        <p className="text-xs text-danger" role="status">
          Quick actions couldn’t load.
        </p>
      ) : null}
    </div>
  );
}
