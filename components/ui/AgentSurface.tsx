"use client";

import { useId, useState, type ReactNode } from "react";
import { Button, cx } from "./kit";

const Spark = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8 1.2l1.5 4.1a2 2 0 0 0 1.2 1.2L14.8 8l-4.1 1.5a2 2 0 0 0-1.2 1.2L8 14.8l-1.5-4.1a2 2 0 0 0-1.2-1.2L1.2 8l4.1-1.5a2 2 0 0 0 1.2-1.2z"
    />
  </svg>
);

/**
 * The agent surface (G1-G5): the one look for what a bot proposes (`proposed`, dashed teal) or did by itself
 * (`done`, solid teal, always with Undo). Both carry the wash and glow tokens; nothing a person did uses it, and it
 * never moves. A card says who, the title, a reason of two lines at most, then its actions: Start or Send, Not now,
 * and "Why this?" (`more`, opened in place). Where the view already has a blue primary, pass `quiet` and the
 * card's own primary is a quiet button too.
 */
export function AgentSurface({
  variant,
  who,
  title,
  why,
  more,
  primary,
  actions,
  quiet,
  className,
  testId,
}: {
  variant: "proposed" | "done";
  /** "Home coordinator suggests", "Chief of staff · just now". */
  who: ReactNode;
  title: ReactNode;
  /** Why, from the owner's own work: two lines at most. */
  why?: ReactNode;
  /** Behind "Why this?": the evidence and exactly what the action will do. */
  more?: ReactNode;
  /** The one action that does it: Start, Send, Open task. */
  primary?: { label: string; onClick: () => void; busy?: boolean };
  /** Not now, Undo and the like: quiet. */
  actions?: ReactNode;
  quiet?: boolean;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <article className={cx("k-surface", className)} data-variant={variant} data-testid={testId} aria-labelledby={`${id}-t`}>
      <span className="k-surface-who">
        <Spark />
        {who}
      </span>
      <h3 id={`${id}-t`} className="k-surface-t">
        {title}
      </h3>
      {why ? <p className="k-surface-why">{why}</p> : null}
      {open && more ? (
        <div className="k-surface-more" id={`${id}-more`}>
          {more}
        </div>
      ) : null}
      {primary || actions || more ? (
        <div className="k-surface-acts">
          {primary ? (
            <Button size="sm" variant={quiet ? "secondary" : "agent"} loading={primary.busy} onClick={primary.onClick} aria-describedby={`${id}-t`}>
              {primary.label}
            </Button>
          ) : null}
          {actions}
          {more ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={open ? `${id}-more` : undefined}
              aria-describedby={`${id}-t`}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide why" : "Why this?"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
