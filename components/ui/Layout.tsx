"use client";

/**
 * Layout pieces of the library (docs/ui-library.md): a disclosure, a bottom sheet, a side dock and a two-pane split.
 * Styles are the `.k-disc`, `.k-sheet`, `.k-dock` and `.k-panes` classes in app/globals.css; colours come from tokens.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject, type TouchEvent } from "react";
import { createPortal } from "react-dom";
import { Button, cx } from "./kit";
import { SheetHandle, useSheetDrag } from "./SheetDrag";

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/**
 * A section that opens in place: one row that says what is inside, and the content under it. The row is a real
 * button (`aria-expanded`), so it works with a keyboard and a screen reader. Closed content is not rendered.
 */
export function Disclosure({
  summary,
  meta,
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
  testId,
}: {
  /** What is inside, in a few words. */
  summary: ReactNode;
  /** A quiet note at the end of the row (a count, the latest entry). */
  meta?: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  testId?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = openProp ?? own;
  const id = useId();
  const toggle = () => {
    setOwn(!open);
    onOpenChange?.(!open);
  };
  return (
    <div className={cx("k-disc", className)} data-open={open || undefined} data-testid={testId}>
      <button type="button" className="k-disc-sum" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
        <Chevron className="k-disc-chev" />
        <span className="k-disc-label">{summary}</span>
        {meta ? <span className="k-disc-meta">{meta}</span> : null}
      </button>
      {open ? (
        <div id={`${id}-body`} className="k-disc-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** The sheet's two resting heights in px. Keep in step with `.k-sheet-body` in app/globals.css. */
const sheetHeights = () => ({ half: Math.min(window.innerHeight * 0.6, 560), full: window.innerHeight * 0.9 });

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A bottom sheet: a dialog that rises from the bottom edge on phones. Drag the top of it up for full height and
 * down to close; the grab bar is also a button that switches height, and Escape or a tap outside closes it.
 * Focus moves into the sheet, stays inside it and returns to where it was when the sheet closes.
 */
export function Sheet({
  title,
  onClose,
  children,
  full: fullProp,
  onFull,
  closeLabel = "Close",
  className,
  bodyClassName,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Controlled height (full or half). Left out, the sheet keeps it itself and opens at half height. */
  full?: boolean;
  onFull?: (full: boolean) => void;
  /** Name of the close control in the header. */
  closeLabel?: string;
  className?: string;
  bodyClassName?: string;
  testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [ownFull, setOwnFull] = useState(false);
  const full = fullProp ?? ownFull;
  const setFull = onFull ?? setOwnFull;
  const { zoneProps, handleProps } = useSheetDrag({ panel, full, onFull: setFull, onClose, heights: sheetHeights });
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      restore?.focus?.();
    };
  }, []);
  return createPortal(
    <div
      className={cx("k-sheet", className)}
      data-full={full}
      data-testid={testId}
      onKeyDown={(e) => {
        // A dialog opened from inside the sheet owns its keys: Escape there must not close both.
        if ((e.target as HTMLElement).closest('[role="dialog"]') !== panel.current) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        if (e.key === "Tab") {
          const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
          const first = items[0];
          const last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="k-sheet-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx("k-sheet-body safe-bottom", bodyClassName)}>
        <div {...zoneProps} className="k-sheet-head">
          <SheetHandle {...handleProps} />
          <header className="k-sheet-title">
            <h2 id={titleId}>{title}</h2>
            <Button data-sheet-nodrag size="sm" variant="ghost" iconOnly icon={<Chevron className="k-sheet-close" />} onClick={onClose}>
              {closeLabel}
            </Button>
          </header>
        </div>
        <div className="k-sheet-scroll">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A column docked to the side of a page: it stays in view while the page beside it scrolls, with its own header,
 * a body that scrolls by itself and a footer that stays at the bottom (a composer). Set `--k-dock-top` on an
 * ancestor to the height of anything pinned above it.
 */
export function SideDock({
  label,
  header,
  footer,
  children,
  className,
  testId,
}: {
  /** The dock's accessible name ("Chat"). */
  label: string;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <aside className={cx("k-dock", className)} aria-label={label} data-testid={testId}>
      {header ? <div className="k-dock-head">{header}</div> : null}
      <div className="k-dock-body">{children}</div>
      {footer ? <div className="k-dock-foot">{footer}</div> : null}
    </aside>
  );
}

/** Whether `ref`'s element is at least `min` px wide (false until measured, and on the server). */
export function useSplitWidth(ref: RefObject<HTMLElement | null>, min = 600): boolean {
  return useSyncExternalStore(
    (changed) => {
      const el = ref.current;
      const observer = typeof ResizeObserver === "undefined" || !el ? null : new ResizeObserver(changed);
      if (el) observer?.observe(el);
      window.addEventListener("resize", changed);
      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", changed);
      };
    },
    () => (ref.current?.clientWidth ?? 0) >= min,
    () => false,
  );
}

/** A touch that starts here is not a pane swipe: the thing under the finger scrolls sideways or takes typing. */
function ownsSwipe(target: EventTarget | null, root: HTMLElement): boolean {
  let el = target instanceof Element ? target : null;
  if (el?.closest('[data-scroll-x], [data-noswipe], input, textarea, select, [contenteditable="true"], [role="slider"], pre, table')) return true;
  for (; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflow = getComputedStyle(el).overflowX;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

/** A sideways flick: far enough, clearly more sideways than up or down, and quick. */
const SWIPE_MIN_PX = 56;
const SWIPE_MAX_MS = 700;
/** Touches that start at the screen edge belong to the browser's back gesture. */
const EDGE_PX = 20;

export type SplitPaneItem = { id: string; label: string; content: ReactNode };

/**
 * Two panes of one page. With room (`split`) they sit side by side: the first scrolls with the page and the second
 * is docked beside it. Without room one pane shows at a time: `value` picks it, and a sideways swipe moves to the
 * other one (the host's tabs do the same for a tap or the keyboard). The pane that is not showing is not rendered.
 */
export function SplitPane({
  split,
  panes,
  value,
  onChange,
  className,
}: {
  split: boolean;
  panes: readonly [SplitPaneItem, SplitPaneItem];
  /** The pane shown when there is room for one. */
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; at: number } | null>(null);
  const index = Math.max(
    0,
    panes.findIndex((p) => p.id === value),
  );
  // Which way the pane that is showing came in from (the one before it sat on the other side).
  const [seen, setSeen] = useState(index);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  if (seen !== index) {
    setDirection(index > seen ? "forward" : "back");
    setSeen(index);
  }
  if (split)
    return (
      <div ref={root} className={cx("k-panes", className)} data-split="">
        <section className="k-panes-main" aria-label={panes[0].label}>
          {panes[0].content}
        </section>
        <SideDock label={panes[1].label} className="k-panes-dock">
          {panes[1].content}
        </SideDock>
      </div>
    );
  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    start.current =
      e.touches.length === 1 && t && t.clientX > EDGE_PX && t.clientX < window.innerWidth - EDGE_PX && !ownsSwipe(e.target, e.currentTarget)
        ? { x: t.clientX, y: t.clientY, at: performance.now() }
        : null;
  };
  const onTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    const from = start.current;
    start.current = null;
    const t = e.changedTouches[0];
    if (!from || !t || performance.now() - from.at > SWIPE_MAX_MS) return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;
    if (window.getSelection()?.toString()) return;
    const next = panes[index + (dx < 0 ? 1 : -1)];
    if (next) onChange(next.id);
  };
  return (
    <div
      ref={root}
      className={cx("k-panes", className)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        start.current = null;
      }}
    >
      <div key={panes[index].id} className="k-panes-one" data-pane={panes[index].id} data-enter={direction}>
        {panes[index].content}
      </div>
    </div>
  );
}
