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
  const [detached, setDetached] = useState(false);
  const programmatic = useRef(0);
  const last = useRef({ y: 0, h: 0 });

  const setFollow = useCallback((on: boolean) => {
    if (follow.current === on) return;
    follow.current = on;
    setDetached(!on);
  }, []);

  const toBottom = useCallback(
    (smooth = false) => {
      programmatic.current = performance.now();
      if (smooth) bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      else window.scrollTo({ top: document.documentElement.scrollHeight });
    },
    [bottomRef],
  );

  useEffect(() => {
    const up = () => setFollow(false);
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) up();
    };
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      // Finger moving down the screen scrolls the thread up.
      if (touchY !== null && y !== undefined && y - touchY > 8) up();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home" || (e.key === " " && e.shiftKey)) up();
    };
    const onScroll = () => {
      const y = window.scrollY;
      const h = document.documentElement.scrollHeight;
      // Scrollbar drags have no wheel/touch event: an upward move with unchanged content height is intent.
      // Programmatic scrolls and clamping after content shrank are not.
      if (y < last.current.y - 2 && h === last.current.h && performance.now() - programmatic.current > 400) up();
      else if (!follow.current && gap() <= REATTACH_GAP) setFollow(true);
      last.current = { y, h };
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
    };
  }, [setFollow]);

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

  // First load lands on the latest message.
  const first = useRef(true);
  useEffect(() => {
    if (ready && first.current) {
      first.current = false;
      requestAnimationFrame(() => toBottom());
    }
  }, [ready, toBottom]);

  /** Explicit resume (Jump to latest, composer focus, keyboard opening). */
  const jumpToLatest = useCallback(
    (smooth = false) => {
      setFollow(true);
      toBottom(smooth);
    },
    [setFollow, toBottom],
  );

  return { detached, jumpToLatest, following: follow };
}
