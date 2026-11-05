"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/components/ui/kit";

/** Live state shown as a small dot on an icon action (e.g. a coordinator's runs). */
export type IconActionDot = "running" | "waiting" | "failed" | null | undefined;

const DOT_LABEL: Record<Exclude<IconActionDot, null | undefined>, string> = {
  running: "working",
  waiting: "waiting for you",
  failed: "last run failed",
};

/**
 * A compact icon-only action for page/card headers (N5): 44px touch target on phones,
 * 40px on tablets and desktop, an accessible name (`label`) that is also the native
 * tooltip, and an optional live-state dot. `tone="primary"` marks the header's single
 * primary action; everything else stays quiet. Keep the visible glyph `aria-hidden`.
 */
export const IconAction = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    label: string;
    icon: ReactNode;
    tone?: "primary" | "default";
    dot?: IconActionDot;
    busy?: boolean;
  }
>(function IconAction({ label, icon, tone = "default", dot, busy, className, title, ...rest }, ref) {
  const name = dot ? `${label} (${DOT_LABEL[dot]})` : label;
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      aria-label={name}
      title={title ?? name}
      aria-busy={busy || undefined}
      disabled={rest.disabled || busy}
      data-dot={dot ?? undefined}
      className={cx(
        "jv-iact press relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border sm:h-10 sm:w-10 disabled:cursor-not-allowed disabled:opacity-50",
        tone === "primary"
          ? "border-accent bg-accent text-accent-contrast hover:opacity-90"
          : "border-line bg-surface text-muted hover:border-line-strong hover:bg-surface-2 hover:text-text",
        className,
      )}
    >
      {busy ? <span className="jv-iact-spin h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : icon}
      {dot ? (
        <span
          aria-hidden="true"
          className={cx(
            "absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--surface)]",
            dot === "running" ? "bg-ok" : dot === "waiting" ? "bg-warn" : "bg-danger",
          )}
        />
      ) : null}
    </button>
  );
});

/** ✦ coordinator glyph (same mark as the composer target chip). */
export function CoordinatorGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" className={className} aria-hidden="true" fill="currentColor">
      <path d="M8 1.25c.3 0 .55.2.62.49l.55 2.2a3.5 3.5 0 0 0 2.55 2.55l2.2.55a.64.64 0 0 1 0 1.24l-2.2.55a3.5 3.5 0 0 0-2.55 2.55l-.55 2.2a.64.64 0 0 1-1.24 0l-.55-2.2a3.5 3.5 0 0 0-2.55-2.55l-2.2-.55a.64.64 0 0 1 0-1.24l2.2-.55A3.5 3.5 0 0 0 6.83 3.94l.55-2.2A.64.64 0 0 1 8 1.25Z" />
    </svg>
  );
}

/** Focused work glyph: a target. */
export function FocusGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 .75v2.5M8 12.75v2.5M.75 8h2.5M12.75 8h2.5" strokeLinecap="round" />
    </svg>
  );
}
