"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";

/** How long a card stays up when a carousel is cycling. */
const CYCLE_MS = 7000;

export type Slide = { key: string; label: string; node: ReactNode };

/**
 * One row of cards that scrolls itself (snap), never the page: one card wide on
 * the cover screen with the next one peeking in, two across when unfolded.
 * Swipe, use the arrow keys, or the arrows where there is a mouse. Pips and
 * arrows appear only when there is somewhere to go. With `cycle` it moves on by
 * itself while it is on screen, pauses under the pointer or focus, and stays put
 * for good once it is touched. With `fit` the cards keep their own heights and
 * the row is as tall as the ones showing.
 */
export function Carousel({
  id,
  title,
  slides,
  cycle = false,
  fit = false,
  testId,
}: {
  id: string;
  title: string;
  slides: Slide[];
  cycle?: boolean;
  fit?: boolean;
  testId?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [stops, setStops] = useState<number[]>([0]);
  const [touched, setTouched] = useState(false);
  /** fit: the row's height, and whether it has been measured once (so the first size does not animate) */
  const [height, setHeight] = useState<number | null>(null);
  const [eased, setEased] = useState(false);
  const held = useRef(false);
  const onScreen = useRef(false);
  const at = useRef(0);
  const stopsRef = useRef<number[]>([0]);
  const count = slides.length;

  /** Where the track can rest: each card's start that can be reached, and the very end. */
  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const first = (el.children[0] as HTMLElement | undefined)?.offsetLeft ?? 0;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const next = Array.from(el.children, (c) => (c as HTMLElement).offsetLeft - first).filter((o) => o <= max + 2);
    if (!next.length) next.push(0);
    if (max - next[next.length - 1]! > 8) next.push(max);
    stopsRef.current = next;
    setStops((cur) => (cur.length === next.length && cur.every((v, i) => Math.abs(v - next[i]!) < 1) ? cur : next));
    let best = 0;
    for (let i = 1; i < next.length; i++) if (Math.abs(next[i]! - el.scrollLeft) < Math.abs(next[best]! - el.scrollLeft)) best = i;
    at.current = best;
    setIndex(best);
    if (fit) {
      // As tall as the cards that show when the row rests here, the one peeking in included.
      const from = next[best]!;
      const to = from + el.clientWidth;
      let tall = 0;
      for (const c of Array.from(el.children) as HTMLElement[]) {
        if (c.offsetLeft + c.offsetWidth > from + 12 && c.offsetLeft < to - 12) tall = Math.max(tall, c.offsetHeight);
      }
      const cs = getComputedStyle(el);
      const h = Math.ceil(tall + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
      if (tall > 0) setHeight((cur) => (cur === h ? cur : h));
    }
  }, [fit]);

  const go = useCallback((i: number) => {
    const el = track.current;
    const all = stopsRef.current;
    const left = all[Math.max(0, Math.min(all.length - 1, i))];
    if (!el || left === undefined) return;
    // Scroll the row itself, never the page: a card must not pull the reader back up to it.
    el.scrollTo({ left, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [measure, count]);

  useEffect(() => {
    const el = track.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => (onScreen.current = Boolean(e?.isIntersecting)), { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (height === null || eased) return;
    const t = window.requestAnimationFrame(() => setEased(true));
    return () => window.cancelAnimationFrame(t);
  }, [height, eased]);

  const pages = stops.length;
  useEffect(() => {
    if (!cycle || touched || pages < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => {
      if (held.current || !onScreen.current || document.hidden) return;
      go((at.current + 1) % stopsRef.current.length);
    }, CYCLE_MS);
    return () => window.clearInterval(t);
  }, [cycle, touched, pages, go]);

  if (!count) return null;
  const stop = () => setTouched(true);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    stop();
    // Arrow keys move a card at a time, only when the row itself has focus (not a control inside a card).
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      go(at.current + (e.key === "ArrowRight" ? 1 : -1));
    }
  };
  return (
    <section aria-labelledby={id} aria-roledescription="carousel" data-testid={testId}>
      <div className="brief-deck-head">
        <h2 className="brief-h" id={id}>
          {title}
        </h2>
        {pages > 1 ? (
          <>
            <span className="brief-deck-pips" aria-hidden="true">
              {stops.map((s, i) => (
                <i key={i} data-on={i === index || undefined} />
              ))}
            </span>
            <span className="brief-deck-nav">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                disabled={index === 0}
                icon={<ChevronIcon className="h-4 w-4 rotate-180" />}
                onClick={() => {
                  stop();
                  go(index - 1);
                }}
              >
                Previous: {title}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                disabled={index === pages - 1}
                icon={<ChevronIcon className="h-4 w-4" />}
                onClick={() => {
                  stop();
                  go(index + 1);
                }}
              >
                Next: {title}
              </Button>
            </span>
          </>
        ) : null}
      </div>
      <div
        ref={track}
        className="brief-deck"
        data-fit={fit ? (eased ? "ready" : "") : undefined}
        style={fit && height !== null ? { height } : undefined}
        role="group"
        aria-label={`${title}: swipe or use the arrow keys`}
        tabIndex={0}
        onScroll={measure}
        onPointerDown={stop}
        onWheel={stop}
        onKeyDown={onKey}
        onPointerEnter={() => (held.current = true)}
        onPointerLeave={() => (held.current = false)}
        onFocus={() => (held.current = true)}
        onBlur={() => (held.current = false)}
      >
        {slides.map((s, i) => (
          <div key={s.key} className="brief-slide" role="group" aria-roledescription="slide" aria-label={`${s.label}, ${i + 1} of ${count}`}>
            {s.node}
          </div>
        ))}
      </div>
    </section>
  );
}
