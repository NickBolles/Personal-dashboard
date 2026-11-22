"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How close to the bottom (px) counts as "at the latest message" again after the person scrolled up. */
const REATTACH_GAP = 48;

/** Where the thread scrolls: the page itself (the chat page), or an element (a thread docked in a pane or a panel). */
type Scroller = HTMLElement | null;
/** How far it is scrolled, and how far it can be. */
const position = (el: Scroller) =>
  el ? { y: el.scrollTop, max: el.scrollHeight - el.clientHeight } : { y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight };
const gap = (el: Scroller) => {
  const p = position(el);
  return p.max - p.y;
};
/** There is nowhere to scroll. */
const fits = (el: Scroller) => position(el).max <= 1;

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

/**
 * Chat scroll follow (Phase 2, profile-first). Follows the bottom while the person is there and ONLY
 * stops on their intent (wheel/touch/keys/scrollbar moving up), never because content grew. While
 * following, any growth of the thread — streamed text, tool cards expanding, late image loads,
 * reconciled history — keeps the latest content in view (ResizeObserver, not a text-length heuristic).
 * When detached, nothing scrolls the page: the browser's scroll anchoring keeps their place, and
 * "Jump to latest" resumes following. `below` says whether there really is content under the fold:
 * the jump button is only offered then (never on a thread that fits the screen).
 *
 * `scrollerRef` is the element that scrolls when the thread does not scroll the page (a thread docked beside a
 * page, or inside a panel). `contentRef` is then the content inside it. Left out, the page scrolls.
 */
export function useFollowScroll(
  contentRef: RefObject<HTMLElement | null>,
  bottomRef: RefObject<HTMLElement | null>,
  ready: boolean,
  scrollerRef?: RefObject<HTMLElement | null>,
) {
  const scroller = useCallback((): Scroller => scrollerRef?.current ?? null, [scrollerRef]);
  const follow = useRef(true);
  // A message permalink holds its place through transcript growth and composer focus.
  const anchor = useRef<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [below, setBelow] = useState(false);
  const last = useRef({ y: 0 });
  /**
   * How far (px) the thread's end sits under the fold: the top edge of the sticky composer dock, else the viewport
   * bottom. Page-level scroll room is not enough to go by: tablets keep a gutter under the dock, so an empty thread
   * still scrolls. Null when the end marker has no layout yet (then the page gap decides).
   */
  const hidden = useCallback(() => {
    const marker = bottomRef.current;
    if (!marker || !marker.getClientRects().length) return null;
    const el = scroller();
    // An element that scrolls ends at its own bottom edge (the composer sits under it, outside).
    if (el) return marker.getBoundingClientRect().top - el.getBoundingClientRect().bottom;
    const dock = contentRef.current?.parentElement?.querySelector<HTMLElement>(".chat-dock");
    return marker.getBoundingClientRect().top - (dock ? dock.getBoundingClientRect().top : window.innerHeight);
  }, [bottomRef, contentRef, scroller]);
  /** An empty or short thread shows whole even from the top of the page: scrolling up there is not "leaving the latest". */
  const short = useCallback(() => {
    if (fits(scroller())) return true;
    const h = hidden();
    return h !== null && h + position(scroller()).y <= 1;
  }, [hidden, scroller]);
  const measure = useCallback(() => setBelow((hidden() ?? gap(scroller())) > REATTACH_GAP), [hidden, scroller]);

  const setFollow = useCallback((on: boolean) => {
    follow.current = on;
    setDetached(!on);
  }, []);

  const toBottom = useCallback(
    (smooth = false) => {
      const el = scroller();
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      else if (smooth) bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      else window.scrollTo({ top: document.documentElement.scrollHeight });
    },
    [bottomRef, scroller],
  );

  useEffect(() => {
    const releaseAnchor = () => {
      anchor.current = null;
    };
    const up = () => {
      if (short()) return;
      setFollow(false);
      measure();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY) releaseAnchor();
      if (e.deltaY < 0) up();
    };
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && Math.abs(y - touchY) > 8) releaseAnchor();
      // Finger moving down the screen scrolls the thread up.
      if (touchY !== null && y !== undefined && y - touchY > 8) up();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(e.key)) releaseAnchor();
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home" || (e.key === " " && e.shiftKey)) up();
    };
    const el = scroller();
    const onScroll = () => {
      const { y, max } = position(el);
      // scrollIntoView itself fires scroll; it must not unlock a permalink near the bottom.
      if (anchor.current) {
        last.current = { y };
        return;
      }
      // Scrollbar drags / emulated wheels can arrive with no wheel/touch event: any upward move that isn't
      // the browser clamping to a shrunken page (y pinned at the new max) is the person's intent.
      // Following only ever scrolls DOWN, so programmatic scrolls never trip this.
      if (y < last.current.y - 2 && y < max - 2) up();
      else if (!follow.current && gap(el) <= REATTACH_GAP) setFollow(true);
      measure();
      last.current = { y };
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === (el ?? document.documentElement)) releaseAnchor(); // scrollbar drag
    };
    // The person's scrolling is heard where the thread scrolls: the page, or the element (once it is there).
    const on: Pick<Window, "addEventListener" | "removeEventListener"> = el ?? window;
    on.addEventListener("wheel", onWheel as EventListener, { passive: true });
    on.addEventListener("touchstart", onTouchStart as EventListener, { passive: true });
    on.addEventListener("touchmove", onTouchMove as EventListener, { passive: true });
    on.addEventListener("keydown", onKey as EventListener);
    on.addEventListener("scroll", onScroll, { passive: true });
    on.addEventListener("pointerdown", onPointerDown as EventListener, { passive: true });
    return () => {
      on.removeEventListener("wheel", onWheel as EventListener);
      on.removeEventListener("touchstart", onTouchStart as EventListener);
      on.removeEventListener("touchmove", onTouchMove as EventListener);
      on.removeEventListener("keydown", onKey as EventListener);
      on.removeEventListener("scroll", onScroll);
      on.removeEventListener("pointerdown", onPointerDown as EventListener);
    };
  }, [setFollow, measure, short, scroller, ready]);

  // Resolve only after the transcript mounts. Cached/partial transcripts may add the target later.
  // Lock following before ResizeObserver can schedule a bottom scroll; state updates run in a frame.
  useLayoutEffect(() => {
    if (!ready) return;
    let raf = 0;
    let observer: MutationObserver | undefined;
    const open = () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      const hash = window.location.hash;
      let id: string | null = null;
      try {
        if (hash.startsWith("#msg-")) id = decodeURIComponent(hash.slice(1));
      } catch {
        // A malformed fragment is not a message permalink.
      }
      anchor.current = id;
      follow.current = !id;
      let resolved = false;
      const resolve = () => {
        if (resolved || !id || anchor.current !== id) return;
        const target = document.getElementById(id);
        if (!target || !contentRef.current?.contains(target)) return;
        resolved = true;
        target.scrollIntoView({ block: "center" });
        observer?.disconnect();
      };
      if (id && contentRef.current) {
        observer = new MutationObserver(resolve);
        observer.observe(contentRef.current, { childList: true, subtree: true });
      }
      raf = requestAnimationFrame(() => {
        setFollow(follow.current);
        if (id) resolve();
        else if (follow.current) toBottom();
      });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("hashchange", open);
    };
  }, [contentRef, ready, setFollow, toBottom]);

  // Any size change of the thread while following → stay at the bottom (one scroll per frame at most).
  // The composer dock counts too: when its tray appears or a draft grows, the latest lines must not slide under it.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (follow.current && gap(scroller()) > 1) toBottom();
        // Detached: content that arrived (or collapsed) under the fold decides whether a jump is on offer.
        else if (!follow.current) measure();
      });
    });
    ro.observe(el);
    const dock = el.parentElement?.querySelector(".chat-dock");
    if (dock) ro.observe(dock);
    // An element that scrolls is resized by the composer under it (a growing draft, the status bar appearing).
    const own = scroller();
    if (own) ro.observe(own);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [contentRef, toBottom, ready, measure, scroller]);

  /** Composer focus/keyboard may follow, but only a send or explicit jump overrides a permalink. */
  const jumpToLatest = useCallback(
    (smooth = false, sent = false) => {
      if (anchor.current && !smooth && !sent) return;
      anchor.current = null;
      setFollow(true);
      setBelow(false);
      toBottom(smooth);
    },
    [setFollow, toBottom],
  );

  return { detached, below: detached && below, jumpToLatest, following: follow };
}
