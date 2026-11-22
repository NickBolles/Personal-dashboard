"use client";

import type { CSSProperties } from "react";
import { Button, ButtonLink, KSpinner } from "@/components/ui";
import { GearIcon, RetryIcon, WandIcon } from "@/components/icons";
import { localMinutes } from "@/lib/time";
import type { BriefScheduleEvent, BriefView as View } from "@/lib/brief";
import { arcT, arcY, DAY_END, DAY_START, greetingOf, nextEvent, nowLine, useSky } from "./sky";
import type { BriefActions } from "./useBrief";

const builtAt = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const at = (t: number): CSSProperties => ({ left: `${(t * 100).toFixed(2)}%`, top: `${(arcY(t) * 100).toFixed(2)}%` });

/**
 * The day as an arc from 6 AM to 10 PM: where the day stands, and where today's
 * calendar sits on it. Decorative: the same facts are in the "right now" line.
 */
function Arc({ minutes, now, events, timezone }: { minutes: number; now: number; events: BriefScheduleEvent[]; timezone: string }) {
  const t = arcT(minutes);
  const up = minutes >= DAY_START && minutes <= DAY_END;
  const next = nextEvent(events, now)?.id;
  return (
    <div className="brief-arc" aria-hidden="true" data-up={up || undefined}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path className="brief-arc-track" d="M0 100 Q50 -90 100 100" />
      </svg>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ clipPath: `inset(-20% ${(100 - t * 100).toFixed(2)}% -20% -5%)` }}>
        <path className="brief-arc-done" d="M0 100 Q50 -90 100 100" />
      </svg>
      {events
        .filter((e) => !e.allDay)
        .map((e) => {
          const m = localMinutes(new Date(e.startsAt), timezone);
          if (m < DAY_START || m > DAY_END) return null;
          return <i key={e.id} className="brief-arc-ev" data-past={e.past || undefined} data-next={e.id === next || undefined} style={at(arcT(m))} />;
        })}
      <i className="brief-arc-sun" style={at(t)} />
    </div>
  );
}

/** The headline arrives a word at a time, once per brief. */
function Words({ text }: { text: string }) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <>
      {words.map((w, i) => (
        <span key={i}>
          <span className="brief-w" style={{ "--i": i } as CSSProperties}>
            {w}
          </span>
          {i < words.length - 1 ? " " : null}
        </span>
      ))}
    </>
  );
}

/**
 * The top of the brief: a sky that follows the time of day, the day's arc, the
 * headline and what is true right now. Nothing here waits on a model.
 */
export function BriefSky({ view, actions, canBuild, onImprove }: { view: View; actions: BriefActions; canBuild: boolean; onImprove?: () => void }) {
  const { brief, build, ai } = view;
  const { now, minutes, phase } = useSky(view.timezone);
  const busy = build.state === "queued" || build.state === "building";
  const live = now === null ? [] : nowLine(view, now);
  const today =
    now === null ? "Today" : new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: view.timezone });
  return (
    <section className="brief-sky" data-phase={phase} data-source={brief.source} aria-labelledby="brief-headline">
      <div className="brief-sky-bg" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <header className="brief-sky-top">
        <div className="min-w-0 flex-1">
          <p className="eyebrow" data-dynamic>
            {today}
          </p>
          <h1 className="brief-hello" data-dynamic>
            {minutes === null ? "Your brief" : greetingOf(minutes)}
          </h1>
        </div>
        {canBuild ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RetryIcon className="h-4 w-4" />}
            loading={actions.build.isPending}
            disabled={busy || build.buildsLeft <= 0}
            title={build.buildsLeft <= 0 ? "Rebuilt as often as allowed today" : undefined}
            onClick={() => actions.build.mutate({})}
          >
            Rewrite the brief with what’s true now
          </Button>
        ) : null}
        {onImprove ? (
          <Button variant="ghost" size="sm" iconOnly icon={<WandIcon className="h-4 w-4" />} onClick={onImprove}>
            Improve the brief
          </Button>
        ) : null}
        <ButtonLink href="/settings/brief" variant="ghost" size="sm" iconOnly icon={<GearIcon className="h-4 w-4" />}>
          Brief settings
        </ButtonLink>
      </header>

      {minutes !== null && now !== null ? (
        <Arc minutes={minutes} now={now} events={view.day?.events ?? []} timezone={view.timezone} />
      ) : (
        <div className="brief-arc" aria-hidden="true" />
      )}

      <p className="brief-byline" data-source={brief.source}>
        {brief.source === "ai" ? (
          <>
            <span>Written by Jarvis</span>
            <span data-dynamic>at {builtAt(brief.builtAt)}</span>
          </>
        ) : (
          <span>Built from your Home priorities</span>
        )}
      </p>
      <h2 className="brief-headline" id="brief-headline" key={brief.id ?? "rules"}>
        <Words text={brief.headline} />
      </h2>
      {brief.lead ? <p className="brief-lead">{brief.lead}</p> : null}

      {live.length ? (
        <ul className="brief-now" aria-label="Right now" data-dynamic>
          {live.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}

      {busy ? (
        <p className="brief-status" role="status">
          <KSpinner /> {brief.source === "ai" ? "Rewriting your brief…" : "Jarvis is writing your brief…"}
        </p>
      ) : build.state === "failed" ? (
        <p className="brief-status" data-tone="bad" role="status">
          <span>Couldn’t write the brief: {build.message}</span>
          {ai.on && ai.available && build.buildsLeft > 0 ? (
            <Button size="sm" variant="ghost" loading={actions.build.isPending} onClick={() => actions.build.mutate({})}>
              Try again
            </Button>
          ) : null}
        </p>
      ) : build.state === "blocked" ? (
        <p className="brief-status" data-tone="wn" role="status">
          <span>{build.message}</span>
          <Button size="sm" variant="ghost" loading={actions.build.isPending} onClick={() => actions.build.mutate({ budgetOverride: true })}>
            Build anyway
          </Button>
        </p>
      ) : null}
    </section>
  );
}
