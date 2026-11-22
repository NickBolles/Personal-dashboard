"use client";

import { useSyncExternalStore } from "react";
import { localMinutes } from "@/lib/time";
import type { BriefPickView, BriefScheduleEvent, BriefView } from "@/lib/brief";

/**
 * The brief's sense of time. Everything here is read from the browser clock in
 * the household timezone and recomputed each minute, so the page stays true
 * through the day without asking the server (or a model) for anything.
 */

export type SkyPhase = "dawn" | "day" | "dusk" | "night";

/** The stretch of the day the arc covers: 6 AM to 10 PM. */
export const DAY_START = 6 * 60;
export const DAY_END = 22 * 60;

export function phaseOf(minutes: number): SkyPhase {
  if (minutes < 5 * 60 || minutes >= 21 * 60) return "night";
  if (minutes < 8 * 60) return "dawn";
  if (minutes < 17 * 60) return "day";
  return "dusk";
}

export const greetingOf = (minutes: number) => (minutes < 12 * 60 ? "Good morning" : minutes < 18 * 60 ? "Good afternoon" : "Good evening");

/** 0 at the start of the day's stretch, 1 at its end. */
export const arcT = (minutes: number) => Math.min(1, Math.max(0, (minutes - DAY_START) / (DAY_END - DAY_START)));
/** Height of the arc at `t` in a unit box (0 = top), for the curve `M0 1 Q.5 -.9 1 1`; x is `t` itself. */
export const arcY = (t: number) => 1 - 3.8 * t + 3.8 * t * t;

const subscribe = (cb: () => void) => {
  const t = window.setInterval(cb, 20_000);
  return () => window.clearInterval(t);
};
const minuteNow = () => Math.floor(Date.now() / 60_000);

/** The current minute as epoch ms; null on the server and during hydration, so markup never disagrees. */
export function useNow(): number | null {
  const m = useSyncExternalStore(subscribe, minuteNow, () => null);
  return m === null ? null : m * 60_000;
}

export function useSky(timezone: string | undefined) {
  const now = useNow();
  const minutes = now === null || !timezone ? null : localMinutes(now, timezone);
  return { now, minutes, phase: minutes === null ? ("day" as const) : phaseOf(minutes) };
}

const clock = (iso: string, timeZone: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone });

function span(mins: number) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const allPicks = (brief: BriefView["brief"]): BriefPickView[] => [...(brief.first ? [brief.first] : []), ...brief.then];

/** The pick to be on now: the first one still open, in the brief's order. */
export const currentPick = (brief: BriefView["brief"]) => allPicks(brief).find((p) => p.state === "open");

export function nextEvent(events: BriefScheduleEvent[], now: number) {
  return events.find((e) => !e.allDay && new Date(e.startsAt).getTime() > now);
}

/**
 * What is true right now, in a few words: where the calendar stands and how far
 * through the picks the person is. Facts only, from Jarvis' own data.
 */
export function nowLine(view: BriefView, now: number): string[] {
  const out: string[] = [];
  const timed = (view.day?.events ?? []).filter((e) => !e.allDay);
  const inIt = timed.find((e) => new Date(e.startsAt).getTime() <= now && e.endsAt && new Date(e.endsAt).getTime() > now);
  const next = nextEvent(timed, now);
  if (inIt) out.push(`${inIt.title} until ${clock(inIt.endsAt!, view.timezone)}`);
  if (next) {
    const gap = Math.max(1, Math.round((new Date(next.startsAt).getTime() - now) / 60_000));
    if (gap <= 90) out.push(`${next.title} in ${span(gap)}`);
    else if (!inIt) out.push(`Clear until ${clock(next.startsAt, view.timezone)}`);
  } else if (!inIt && view.day?.known) out.push(timed.length ? "Clear for the rest of the day" : "Nothing on the calendar");
  const picks = allPicks(view.brief);
  const done = picks.filter((p) => p.state === "done").length;
  if (picks.length && done === picks.length) out.push(picks.length === 1 ? "Done" : `All ${picks.length} done`);
  else if (done) out.push(`${done} of ${picks.length} done`);
  return out;
}
