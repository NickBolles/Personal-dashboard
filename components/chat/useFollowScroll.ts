"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How close to the bottom (px) counts as "at the latest message" again after the person scrolled up. */
const REATTACH_GAP = 48;

const gap = () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);

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
 * "Jump to latest" resumes following.
 */
export function useFollowScroll(contentRef: RefObject<HTMLElement | null>, bottomRef: RefObject<HTMLElement | null>, ready: boolean) {
  const follow = useRef(true);
  // A message permalink holds its place through transcript growth and composer focus.
  const anchor = useRef<string | null>(null);
  const [detached, setDetached] = useState(false);
  const last = useRef({ y: 0 });

  const setFollow = useCallback((on: boolean) => {
    follow.current = on;
    setDetached(!on);
  }, []);

  const toBottom = useCallback(
    (smooth = false) => {
      if (smooth) bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      else window.scrollTo({ top: document.documentElement.scrollHeight });
    },
    [bottomRef],
  );

  useEffect(() => {
    const releaseAnchor = () => {
      anchor.current = null;
    };
    const up = () => setFollow(false);
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
    const onScroll = () => {
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      // scrollIntoView itself fires scroll; it must not unlock a permalink near the bottom.
      if (anchor.current) {
        last.current = { y };
        return;
      }
      // Scrollbar drags / emulated wheels can arrive with no wheel/touch event: any upward move that isn't
      // the browser clamping to a shrunken page (y pinned at the new max) is the person's intent.
      // Following only ever scrolls DOWN, so programmatic scrolls never trip this.
      if (y < last.current.y - 2 && y < max - 2) up();
      else if (!follow.current && gap() <= REATTACH_GAP) setFollow(true);
      last.current = { y };
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === document.documentElement) releaseAnchor(); // scrollbar drag
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [setFollow]);

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
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!follow.current || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (follow.current && gap() > 1) toBottom();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [contentRef, toBottom, ready]);

  /** Composer focus/keyboard may follow, but only a send or explicit jump overrides a permalink. */
  const jumpToLatest = useCallback(
    (smooth = false, sent = false) => {
      if (anchor.current && !smooth && !sent) return;
      anchor.current = null;
      setFollow(true);
      toBottom(smooth);
    },
    [setFollow, toBottom],
  );

  return { detached, jumpToLatest, following: follow };
}
