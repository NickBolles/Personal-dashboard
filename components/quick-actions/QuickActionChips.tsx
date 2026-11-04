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
  const all = contextualActions(query.data?.actions ?? [], context);
  // The collapsed phone tray shows at most two pinned chips and no Manage button.
  const actions = variant === "tray" ? all.filter((a) => a.pinned).slice(0, 2) : all;
  if (variant === "tray" && !actions.length) return null;
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
        {variant === "tray" ? null : (
          <ChipButton
            className="qa-hit shrink-0"
            aria-label="Manage quick actions"
            onClick={() => window.dispatchEvent(new CustomEvent(QUICK_ACTION_MANAGE, { detail: context }))}
          >
            ⋮
          </ChipButton>
        )}
      </div>
      {query.error && variant !== "tray" ? (
        <p className="text-xs text-danger" role="status">
          Quick actions couldn’t load.
        </p>
      ) : null}
    </div>
  );
}
