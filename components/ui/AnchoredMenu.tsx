"use client";

/**
 * Anchored menu: a kit `Menu` opened from a visible ⋯ trigger (`MenuButton`), a right-click, the keyboard's
 * Menu key / Shift+F10, or a long press on touch, anywhere on a surface (a card, a tray).
 *
 * - Placement: fixed to the viewport at the trigger (below it, end-aligned) or at the pointer, then flipped /
 *   clamped so it never leaves the viewport (collision-aware). Width comes from the `--k-menu-w` token and
 *   labels wrap instead of truncating, so 200% text stays readable.
 * - Dismiss: Esc, a pointer outside, scrolling the page under it, or choosing an item.
 * - Focus: the first item on open (roving focus from `Menu`); on close focus RETURNS to what opened it (the ⋯
 *   trigger, or the control inside the surface that had focus, else the surface's own ⋯ trigger), unless the
 *   chosen action moved focus somewhere on purpose.
 *
 * Usage:
 *   const menu = useAnchoredMenu();
 *   <article {...menu.surfaceProps}>
 *     <MenuButton menu={menu} label="Actions for R-12" />
 *     <AnchoredMenu menu={menu} label="Actions for R-12" items={items} />
 *   </article>
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Menu, type KMenuItem } from "./kit";

type Point = { x: number; y: number; align: "start" | "end"; /** Bottom edge to use when there is no room below (the trigger's top). */ flipY?: number };
const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;
const EDGE = 8;
/** Popover API (top layer). Checked on use: the menu only renders after an interaction, so never on the server. */
const supportsPopover = () => typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

export type AnchoredMenuState = ReturnType<typeof useAnchoredMenu>;

function focusable(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && !el.hasAttribute("disabled") && el.tabIndex >= 0;
}

/** State + handlers for one anchored menu. `enabled: false` leaves the browser's own context menu alone. */
export function useAnchoredMenu({ enabled = true }: { enabled?: boolean } = {}) {
  const [at, setAt] = useState<Point | null>(null);
  const setTrigger = useCallback((el: HTMLButtonElement | null) => {
    trigger.current = el;
  }, []);
  const isTrigger = useCallback((node: Node | null) => !!node && !!trigger.current?.contains(node), []);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);

  const openAt = useCallback((point: Point, from: HTMLElement | null) => {
    opener.current = from;
    setAt(point);
  }, []);

  /** Open from the ⋯ trigger: below it, end edges aligned. */
  const openFromTrigger = useCallback(() => {
    const el = trigger.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    openAt({ x: r.right, y: r.bottom + 4, flipY: r.top - 4, align: "end" }, el);
  }, [openAt]);

  const close = useCallback(() => {
    setAt(null);
    const back = focusable(opener.current) ? opener.current : focusable(trigger.current) ? trigger.current : null;
    opener.current = null;
    // After the menu unmounts: give focus back only when it was in the menu (now gone) or fell to the page, so an
    // action that focused something on purpose (a composer, a dialog) keeps it.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (back && (!active || active === document.body || !active.isConnected)) back.focus({ preventScroll: true });
    });
  }, []);

  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );

  const ignored = (target: EventTarget | null) =>
    !!(target as HTMLElement | null)?.closest?.("a, input, textarea, select, [role='menu'], [contenteditable='true']");

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!enabled || ignored(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    // A long press already opened it (Android also fires contextmenu for the same press).
    if (press.current?.fired) return;
    const active = document.activeElement;
    const from = active instanceof HTMLElement && event.currentTarget.contains(active) && active !== document.body ? active : null;
    // The keyboard's Menu key / Shift+F10 report no pointer position: open at the surface's top-left.
    if (event.clientX === 0 && event.clientY === 0) {
      const r = event.currentTarget.getBoundingClientRect();
      openAt({ x: r.left + 12, y: r.top + 36, align: "start" }, from);
    } else openAt({ x: event.clientX, y: event.clientY, align: "start" }, from);
  };

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType !== "touch" || ignored(event.target)) return;
    cancelPress();
    const surface = event.currentTarget;
    const x = event.clientX;
    const y = event.clientY;
    const state = { x, y, fired: false, timer: 0 };
    state.timer = window.setTimeout(() => {
      state.fired = true;
      const active = document.activeElement;
      openAt({ x, y, align: "start" }, active instanceof HTMLElement && surface.contains(active) ? active : null);
    }, LONG_PRESS_MS);
    press.current = state;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (p && !p.fired && Math.hypot(event.clientX - p.x, event.clientY - p.y) > MOVE_SLOP) cancelPress();
  };
  const onPointerUp = () => {
    cancelPress();
    // Keep `fired` until the click that follows the long press has been swallowed (onClickCapture).
    if (press.current && !press.current.fired) press.current = null;
  };
  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (press.current?.fired) {
      // The finger lifting after a long press is not a tap on what was under it.
      event.preventDefault();
      event.stopPropagation();
      press.current = null;
    }
  };

  return {
    at,
    open: !!at,
    close,
    openAt,
    openFromTrigger,
    /** Callback ref for the ⋯ trigger (MenuButton). */
    setTrigger,
    /** Whether a node is (inside) the ⋯ trigger: it toggles on its own click. */
    isTrigger,
    enabled,
    /** Spread on the surface (card, tray) that answers right-click, the Menu key and a long press. */
    surfaceProps: { onContextMenu, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClickCapture },
  };
}

/** The visible ⋯ trigger. Kit icon button (44px phone / 40px desktop hit area). */
export function MenuButton({ menu, label, className }: { menu: AnchoredMenuState; label: string; className?: string }) {
  const { enabled, open, close, openFromTrigger, setTrigger } = menu;
  if (!enabled) return null;
  return (
    <Button
      ref={setTrigger}
      variant="ghost"
      size="sm"
      iconOnly
      className={["k-amenu-trigger", className].filter(Boolean).join(" ")}
      aria-haspopup="menu"
      aria-expanded={open}
      icon={<DotsIcon />}
      onClick={(event) => {
        event.stopPropagation();
        if (open) close();
        else openFromTrigger();
      }}
    >
      {label}
    </Button>
  );
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="12.5" cy="8" r="1.4" />
    </svg>
  );
}

/** The menu itself, placed at `menu.at` and kept inside the viewport. */
/** How long after opening a page scroll is taken as one that began before the menu opened. */
const SCROLL_GRACE_MS = 250;

export function AnchoredMenu({ menu, label, items, className }: { menu: AnchoredMenuState; label: string; items: KMenuItem[]; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { at, close, isTrigger } = menu;
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  // Collision-aware placement: measure, then flip above / shift left so the whole menu is on screen.
  useLayoutEffect(() => {
    if (!at || !box.current) return;
    const el = box.current as HTMLDivElement & { showPopover?: () => void };
    // Top layer when the browser has it: no ancestor's transform, overflow or stacking can clip or shift it.
    try {
      if (el.showPopover && !el.matches(":popover-open")) el.showPopover();
    } catch {
      /* not supported: plain fixed positioning */
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = at.align === "end" ? at.x - w : at.x;
    let top = at.y;
    if (top + h > vh - EDGE) top = (at.flipY ?? at.y) - h;
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - w - EDGE));
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - h - EDGE));
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [at]);

  // The menu stays hidden until it is placed, and a hidden element cannot take focus: in a real browser Menu's own
  // focus-on-mount runs too early on the first open, leaving focus on the trigger (so Esc and the arrows did
  // nothing). Once placed, move focus to the first item unless it is already inside.
  useEffect(() => {
    const el = box.current;
    if (!at || !pos || !el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true });
  }, [at, pos]);

  useEffect(() => {
    if (!at) return;
    const outside = (event: Event) => {
      const t = event.target as Node | null;
      if (box.current?.contains(t)) return;
      // The trigger toggles on its own click.
      if (isTrigger(t)) return;
      closeRef.current();
    };
    // Scroll events are delivered a frame late: a scroll that brought the trigger into view just before the tap
    // (or the tail of a flick) would otherwise close the menu the moment it opens.
    const openedAt = performance.now();
    const onScroll = (event: Event) => {
      if (box.current?.contains(event.target as Node)) return;
      if (performance.now() - openedAt < SCROLL_GRACE_MS) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", onScroll, true);
    const onResize = () => closeRef.current();
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [at, isTrigger]);

  if (!at) return null;
  const style = { left: pos?.left ?? at.x, top: pos?.top ?? at.y, visibility: pos ? undefined : "hidden" } as CSSProperties;
  return (
    <div
      ref={box}
      popover={supportsPopover() ? "manual" : undefined}
      className={["k-amenu", className].filter(Boolean).join(" ")}
      style={style}
      data-testid="anchored-menu"
    >
      <Menu label={label} items={items} onClose={close} />
    </div>
  );
}
