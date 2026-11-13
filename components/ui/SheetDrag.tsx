"use client";

import { useEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { sheetSnap } from "@/lib/client/sheet-snap";
import { cx } from "@/components/ui/kit";

/** Movement (px) before a press on the handle counts as a drag instead of a tap. */
const SLOP = 6;
/** How long the sheet slides away before it is removed (matches --d2). */
const LEAVE_MS = 160;

/** After a press ends, how long (ms) the click the browser derives from it is ignored: the press already acted. */
const CLICK_MS = 400;

type Drag = { id: number; onHandle: boolean; y0: number; h0: number; y: number; t: number; v: number; moved: boolean; half: number; max: number };

/** Above half height the sheet grows; below it, it keeps its half height and slides off the bottom. */
function place(el: HTMLElement, d: Drag, height: number) {
  if (height >= d.half) {
    el.style.height = `${Math.min(height, d.max)}px`;
    el.style.transform = "";
  } else {
    el.style.height = `${d.half}px`;
    el.style.transform = `translateY(${d.half - Math.max(height, 0)}px)`;
  }
}
function rest(el: HTMLElement) {
  el.removeAttribute("data-dragging");
  el.style.height = "";
  el.style.transform = "";
}
function slideAway(el: HTMLElement) {
  el.removeAttribute("data-dragging");
  el.style.transform = "translateY(100%)";
}

/**
 * Drag behaviour for a bottom sheet with two resting heights: drag the top of it up for full height, down for
 * half height, and further down (or flick down) to close. The sheet follows the finger and settles when it lifts.
 *
 * Spread `zoneProps` on the strip that can be dragged (the handle and the header) and `handleProps` on a
 * `SheetHandle`. Controls inside the strip that must stay plain taps carry `data-sheet-nodrag`.
 * Everything a drag does is also reachable without one: tapping the handle switches height, the arrow keys move
 * between heights, and the sheet keeps its own close control.
 */
export function useSheetDrag({
  panel,
  full,
  onFull,
  onClose,
  heights,
}: {
  /** The element that is resized and moved. Its resting heights come from CSS; a drag only sets inline styles. */
  panel: RefObject<HTMLElement | null>;
  full: boolean;
  onFull: (full: boolean) => void;
  onClose: () => void;
  /** The two resting heights in px, read when a drag starts (they depend on the viewport). */
  heights: () => { half: number; full: number };
}) {
  const drag = useRef<Drag | null>(null);
  const swallowUntil = useRef(0);
  const leaving = useRef(0);
  useEffect(() => () => window.clearTimeout(leaving.current), []);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-sheet-nodrag]")) return;
    const el = panel.current;
    if (!el || leaving.current) return;
    const h = heights();
    const h0 = el.getBoundingClientRect().height || (full ? h.full : h.half);
    // Capture from the press on: a mouse dragged up leaves the strip at once. The tap is then handled in `finish`,
    // because a captured press sends its click to the strip instead of the handle.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const onHandle = !!(e.target as HTMLElement).closest(".k-sheet-handle");
    drag.current = { id: e.pointerId, onHandle, y0: e.clientY, h0, y: e.clientY, t: performance.now(), v: 0, moved: false, half: h.half, max: h.full };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = panel.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.abs(dy) < SLOP) return;
      d.moved = true;
      el.setAttribute("data-dragging", "");
    }
    const now = performance.now();
    const dt = now - d.t;
    if (dt > 0) d.v = 0.7 * ((e.clientY - d.y) / dt) + 0.3 * d.v;
    d.y = e.clientY;
    d.t = now;
    place(el, d, d.h0 - dy);
  };
  const finish = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const el = panel.current;
    if (!el) return;
    swallowUntil.current = performance.now() + CLICK_MS;
    if (!d.moved) {
      // A tap on the grab bar switches height.
      if (!cancelled && d.onHandle) onFull(!full);
      return;
    }
    // A finger that rested before lifting is not a flick.
    if (performance.now() - d.t > 100) d.v = 0;
    const to = cancelled ? (full ? "full" : "half") : sheetSnap({ height: d.h0 - (e.clientY - d.y0), velocity: d.v, half: d.half, full: d.max });
    if (to === "closed") {
      const still = typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      slideAway(el);
      if (still) return onClose();
      leaving.current = window.setTimeout(onClose, LEAVE_MS);
      return;
    }
    rest(el);
    if ((to === "full") !== full) onFull(to === "full");
  };

  return {
    zoneProps: {
      "data-sheet-drag": "",
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: PointerEvent<HTMLElement>) => finish(e, false),
      onPointerCancel: (e: PointerEvent<HTMLElement>) => finish(e, true),
      // The click a press or drag ends with must not toggle the handle a second time. Keyboard and assistive
      // clicks (detail 0) always go through.
      onClickCapture: (e: MouseEvent<HTMLElement>) => {
        if (e.detail === 0 || performance.now() > swallowUntil.current) return;
        e.preventDefault();
        e.stopPropagation();
      },
    },
    handleProps: {
      full,
      onClick: () => onFull(!full),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === "ArrowUp" && !full) {
          e.preventDefault();
          onFull(true);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          if (full) onFull(false);
          else onClose();
        }
      },
    },
  };
}

/**
 * The grab bar at the top of a bottom sheet. It is a real button: a tap (or Enter / Space) switches between half
 * and full height, Arrow up / Arrow down move between heights, and Arrow down at half height closes the sheet.
 */
export function SheetHandle({ full, className, ...rest }: { full: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type">) {
  return (
    <button
      type="button"
      {...rest}
      className={cx("k-sheet-handle", className)}
      aria-label={full ? "Half height" : "Full height"}
      title="Drag up for full height, down to close"
    >
      <span aria-hidden="true" />
    </button>
  );
}
