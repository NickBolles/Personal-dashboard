"use client";

import Link from "next/link";
import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Button, cx } from "@/components/ui/kit";
import { WORK_WORD, type WorkState } from "@/lib/work-words";

/** A row's state: the shared work states (lib/work-words.ts), or "idle" for a thing nothing is happening to. */
export type ThingState = WorkState | "idle";

type DataAttrs = { [key: `data-${string}`]: string | boolean | undefined };

/** The state mark at the start of a row: filled when it needs the owner, pulsing while working, a tick when done. */
export function StateDot({ state, label }: { state: ThingState; label?: string }) {
  return (
    <span className="k-sd" data-state={state} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {state === "done" ? (
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m2.5 6.3 2.3 2.3 4.7-5" />
        </svg>
      ) : null}
    </span>
  );
}

/** The state in words, in its colour. One word per state everywhere: pass children only to add to it, never to rename it. */
export function StateWord({ state, children }: { state: WorkState; children?: ReactNode }) {
  return (
    <span className="k-sw" data-state={state}>
      {children ?? WORK_WORD[state]}
    </span>
  );
}

const spoken = (id: string) => `${id.startsWith("D") ? "Decision" : "Run"} ${id.replace("-", " ")}`;

/**
 * A reference to a decision (D-n, amber) or a piece of work (R-n, teal). With `onClick` it is the chip that jumps to
 * the thing; without, it is the label on the thing's own row.
 */
export function RefPill({ id, onClick, className }: { id: string; onClick?: () => void; className?: string }) {
  const kind = id.startsWith("D") ? "d" : "r";
  return onClick ? (
    <button type="button" className={cx("k-ref", className)} data-kind={kind} aria-label={spoken(id)} onClick={onClick}>
      {id}
    </button>
  ) : (
    <span className={cx("k-ref", className)} data-kind={kind} role="img" aria-label={spoken(id)}>
      {id}
    </span>
  );
}

/**
 * An icon action on a row (Steer, Stop, Retry, Log, Open). Always an icon with a name; the name is also the tooltip.
 * Rows show at most the two that matter for their state, in that fixed order; the rest live in the row's menu.
 */
export function RowAction({
  label,
  icon,
  tone,
  className,
  ...rest
}: { label: string; icon: ReactNode; tone?: "danger" } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon={icon}
      title={label}
      className={cx("k-thing-act", tone === "danger" && "k-thing-act-danger", className)}
      {...rest}
    >
      {label}
    </Button>
  );
}

/**
 * The one row for a decision, a piece of work or an item, on every surface: line one says what it is (its D-n / R-n
 * and title), line two says its state. Icon actions sit on the right. A row can open in place (`expanded` plus
 * children) to show what a card would: progress, the latest update, links.
 *
 * - `onOpen`: the row body is a button (it toggles `expanded`, or opens the thing). `href`: the body is a link.
 * - `tight`: one line (title, then `sub` beside it): finished work, collapsed groups.
 * - `status`: the stacked form. Line one is the reference, the state mark and `status` (the state word and its
 *   time); line two is the title, which is then the link or button (`href` / `onOpen`) that opens the thing itself;
 *   line three is `sub`, a one-line peek. Opening in place is a separate control: pass `onToggle`.
 * - A screen draws each thing as a row once. Any other mention of it is a `RefPill`.
 */
export function ThingRow({
  state,
  refId,
  title,
  status,
  sub,
  actions,
  onOpen,
  onToggle,
  toggleLabel = "Details",
  href,
  expanded,
  tight,
  children,
  className,
  hitProps,
  ...rest
}: {
  state: ThingState;
  refId?: string;
  title: ReactNode;
  /** Stacked form: what follows the state mark on line one (state word, time). */
  status?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  onOpen?: () => void;
  /** Stacked form: toggles `expanded` from its own chevron button, named `toggleLabel`. */
  onToggle?: () => void;
  toggleLabel?: string;
  href?: string;
  /** Set (true or false) on a row that opens in place; leave undefined on one that does not. */
  expanded?: boolean;
  tight?: boolean;
  children?: ReactNode;
  className?: string;
  /** Extra attributes for the row body (the button or link), e.g. a ref-carrying data attribute or aria-label. */
  hitProps?: HTMLAttributes<HTMLElement> & DataAttrs;
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "children"> &
  DataAttrs) {
  const panel = useId();
  const open = !!expanded && children != null;
  if (status !== undefined) {
    const titleProps = { className: "k-thing-title", ...hitProps };
    return (
      <div {...rest} className={cx("k-thing", className)} data-state={state} data-open={open || undefined} data-stacked="">
        <div className="k-thing-row">
          <div className="k-thing-main">
            <span className="k-thing-eyebrow">
              {refId ? <RefPill id={refId} /> : null}
              <StateDot state={state} />
              {status}
            </span>
            {href ? (
              <Link href={href} {...titleProps}>
                {title}
              </Link>
            ) : onOpen ? (
              <button type="button" onClick={onOpen} {...titleProps}>
                {title}
              </button>
            ) : (
              <span {...titleProps}>{title}</span>
            )}
            {sub ? <span className="k-thing-s">{sub}</span> : null}
          </div>
          {actions || onToggle ? (
            <span className="k-thing-acts">
              {actions}
              {onToggle ? (
                <RowAction
                  label={toggleLabel}
                  data-thing-toggle=""
                  aria-expanded={open}
                  aria-controls={open ? panel : undefined}
                  onClick={onToggle}
                  icon={
                    <svg
                      viewBox="0 0 24 24"
                      className="k-thing-chev h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  }
                />
              ) : null}
            </span>
          ) : null}
        </div>
        {open ? (
          <div className="k-thing-open" id={panel}>
            {children}
          </div>
        ) : null}
      </div>
    );
  }
  const body = (
    <>
      <span className="k-thing-t">
        {refId ? <RefPill id={refId} /> : null}
        <span className="k-thing-title">{title}</span>
        {tight && sub ? <span className="k-thing-inline">{sub}</span> : null}
      </span>
      {!tight && sub ? <span className="k-thing-s">{sub}</span> : null}
    </>
  );
  return (
    <div {...rest} className={cx("k-thing", className)} data-state={state} data-open={open || undefined} data-tight={tight || undefined}>
      <div className="k-thing-row">
        <StateDot state={state} />
        {href ? (
          <Link href={href} className="k-thing-hit" {...hitProps}>
            {body}
          </Link>
        ) : onOpen ? (
          <button
            type="button"
            className="k-thing-hit"
            aria-expanded={expanded === undefined ? undefined : open}
            aria-controls={open ? panel : undefined}
            onClick={onOpen}
            {...hitProps}
          >
            {body}
          </button>
        ) : (
          <span className="k-thing-hit" {...hitProps}>
            {body}
          </span>
        )}
        {actions ? <span className="k-thing-acts">{actions}</span> : null}
      </div>
      {open ? (
        <div className="k-thing-open" id={panel}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
