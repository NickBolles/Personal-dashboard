"use client";

import { useLayoutEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { localDate } from "@/lib/time";
import { ActionCard } from "@/components/actions/ActionCard";
import { CalendarIcon, CheckIcon, PeopleIcon } from "@/components/icons";
import { IconAction, cx, useNow, useOnline } from "@/components/ui";
import { dueState } from "./grouping";
import { choreWrite, listWrite, rescheduleWrite } from "./model";
import { optimisticChecked } from "./writeState";
import { haptic, useSkylightWriteState } from "./writeStore";
import type { SkylightRequest } from "./useSkylightWrite";

/** A swipe this far right (px) completes the row; less springs back. */
export const SWIPE_COMPLETE_PX = 72;

/**
 * Touch swipe-right-to-complete (the checkbox stays the accessible alternative). Only touch pointers, only once the
 * gesture is clearly horizontal, so vertical scrolling (`touch-action: pan-y`) and taps are untouched.
 */
function useSwipe(onComplete: (() => void) | undefined) {
  const start = useRef<{ x: number; y: number; id: number; active: boolean } | null>(null);
  const set = (el: HTMLElement, dx: number) => {
    el.style.setProperty("--sk-dx", `${dx}px`);
    el.style.setProperty("--sk-reveal", String(Math.min(1, dx / SWIPE_COMPLETE_PX)));
  };
  if (!onComplete) return {};
  const end = (e: ReactPointerEvent<HTMLElement>, cancel: boolean) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const el = e.currentTarget;
    const dx = e.clientX - s.x;
    delete el.dataset.swiping;
    set(el, 0);
    if (s.active && !cancel && dx >= SWIPE_COMPLETE_PX) onComplete();
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      const el = e.currentTarget;
      if (!s.active) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          start.current = null; // a scroll, not a swipe
          return;
        }
        if (dx < 12) return;
        s.active = true;
        el.dataset.swiping = "";
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic events */
        }
      }
      const clamped = Math.max(0, Math.min(dx, SWIPE_COMPLETE_PX * 1.4));
      if (clamped >= SWIPE_COMPLETE_PX && el.style.getPropertyValue("--sk-reveal") !== "1") haptic(6);
      set(el, clamped);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e, true),
  };
}

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

/**
 * One Skylight row, the same everywhere it renders (Today, Todos, the Skylight page, the tray card): one-tap
 * checkbox, swipe right on touch, and the #211 suggested actions, all through the confirm card + Undo. Its phase in
 * the shared optimistic store drives the motion (`data-phase`: pending shimmer → strike + collapse, rollback shake,
 * re-enter on Undo); every animation is ≤250 ms and off under prefers-reduced-motion.
 * Skylight never falls through to the generic /api/actions completion endpoint.
 */
export function SkylightActionRow({
  action,
  writable,
  request,
  timezone = "America/Chicago",
  className,
}: {
  action: NextAction;
  writable: boolean;
  request: SkylightRequest;
  /** Kept for callers; suggested actions show on the Skylight page and in Todos alike. */
  management?: boolean;
  timezone?: string;
  className?: string;
}) {
  const online = useOnline();
  const now = useNow();
  const writes = useSkylightWriteState();
  const entry = writes[action.id];
  const phase = entry?.phase;
  const busy = phase === "pending" || phase === "undoing";
  const box = useRef<HTMLDivElement>(null);
  const ref = action.skylight;
  const completed = action.status === "completed";
  const checked = optimisticChecked(action, entry);
  const complete = writable && !completed ? choreWrite(action, "chore.complete") : null;
  const check = writable ? listWrite(action) : null;
  const tone = dueState(action, { now, timezone });
  const suggestions = writable && !busy ? choreSuggestions(action, { now, timezone }) : [];
  const ask = (op: SkylightWriteOp) => request(op, action.id);
  const swipe = useSwipe(complete && online && !busy && !checked ? () => ask(complete) : undefined);
  // Height for the collapse (leaving) and re-enter (restored) keyframes: measured, so the motion is exact.
  useLayoutEffect(() => {
    const el = box.current;
    // A new phase animates again (and clips again until its animation ends).
    if (el) delete el.dataset.settled;
    if (el && (phase === "pending" || phase === "leaving" || phase === "undoing" || phase === "restored" || phase === "done"))
      el.style.setProperty("--sk-h", `${Math.max(el.scrollHeight, 36)}px`);
  }, [phase]);
  return (
    <div
      ref={box}
      className={cx("sk-row [&>.jv-trow]:flex-wrap", className)}
      data-phase={phase}
      data-swipe={swipe.onPointerDown ? "" : undefined}
      aria-busy={busy || undefined}
      // Collapse/enter clip with overflow:hidden only while animating, so the ⋯ menu is never clipped after.
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.dataset.settled = "";
      }}
      style={{ "--sk-dx": "0px" } as CSSProperties}
      {...swipe}
    >
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
        checked={complete ? checked || busy : undefined}
        dueTone={tone === "overdue" ? "danger" : tone === "late" ? "warn" : undefined}
        showSource={ref?.kind === "list_item"}
        onComplete={complete ? () => ask(complete) : undefined}
        leading={
          check ? (
            <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center sm:min-h-9 sm:min-w-9 dense:min-h-[30px] dense:min-w-[30px]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                aria-label={action.title}
                checked={completed}
                disabled={!online || busy}
                onChange={() => ask(check)}
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
                  onClick={() => ask(s.op)}
                />
              ))}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
