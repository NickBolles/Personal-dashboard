"use client";

import Link from "next/link";
import { useAccess } from "@/components/access";
import { ChevronIcon } from "@/components/icons";
import { allPicks, currentPick, useSky } from "./sky";
import { useBrief } from "./useBrief";
import "./brief.css";

/**
 * The list view's door back to the brief (with the AI brief on, the brief is Home and the list is `/home?view=list`): the headline, the pick to be on now and how far
 * through the day's picks the person is, under the same sky as the brief. Home
 * keeps its own structure and ranking; this never waits on a model (the read is
 * local). Shown once the person has turned the AI brief on: the rules brief only
 * restates what Home already shows, so until then the brief lives under More.
 */
export function HomeBriefCard() {
  const allowed = useAccess().can("brief.use");
  const q = useBrief(allowed);
  const view = q.data;
  const { phase } = useSky(view?.timezone);
  const b = view?.brief;
  if (!allowed || !view || !b || !view.ai.on) return null;
  const picks = allPicks(b);
  const current = currentPick(b);
  return (
    <Link
      href="/home"
      className="brief-entry mb-4"
      data-phase={phase}
      data-source={b.source}
      data-testid="home-brief"
      aria-label={`Today's brief: ${b.headline}`}
    >
      <span className="brief-entry-bg" aria-hidden="true">
        <span />
        <span />
      </span>
      <span className="eyebrow">{b.source === "ai" ? "Your brief, written by Atlas" : "Your brief"}</span>
      <span className="brief-entry-h">{b.headline}</span>
      {current ? (
        <span className="brief-entry-s">
          <b>{current === picks[0] ? "Start with" : "Next"}</b> {current.title}
        </span>
      ) : picks.length ? (
        <span className="brief-entry-s">Done for today</span>
      ) : b.lead ? (
        <span className="brief-entry-s">{b.lead}</span>
      ) : null}
      {picks.length > 1 ? (
        <span className="brief-entry-dots" aria-hidden="true">
          {picks.map((p) => (
            <i key={p.actionId} data-state={p.state} data-current={p === current || undefined} />
          ))}
        </span>
      ) : null}
      <ChevronIcon className="h-5 w-5" />
    </Link>
  );
}
