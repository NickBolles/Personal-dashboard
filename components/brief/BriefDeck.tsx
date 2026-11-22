"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, useOnline } from "@/components/ui";
import { CheckIcon, ChevronIcon, SparkleIcon } from "@/components/icons";
import { formatWhen } from "@/components/actions/format";
import {
  BRIEF_ASSIST_DOING,
  BRIEF_ASSIST_LABEL,
  BRIEF_DECK_GROUPS,
  BRIEF_DECK_GROUP_LABEL,
  BRIEF_DECK_GROUP_OF,
  BRIEF_DECK_LABEL,
  type BriefAssistView,
  type BriefDeckCard,
  type BriefDeckRow,
} from "@/lib/brief";
import { Carousel } from "./Carousel";
import type { BriefActions } from "./useBrief";

function rowMeta(r: BriefDeckRow) {
  return [r.meta, r.at ? formatWhen(r.at, r.allDay) : undefined].filter(Boolean).join(" · ");
}

/**
 * What came of the sparkle on a row, from Jarvis' own records: under way, waiting
 * on the person, or the next step the agent left (and the rest of its steps,
 * folded). The line opens the conversation.
 */
function Asked({ title, assist }: { title: string; assist: BriefAssistView }) {
  const r = assist.request!;
  const [open, setOpen] = useState(false);
  // A next step the agent already left is worth more than "still working".
  const hasNext = Boolean(r.next) && r.live !== "waiting" && r.live !== "failed";
  const busy = !hasNext && (r.live === "running" || r.live === "idle");
  const word = hasNext
    ? "Next"
    : busy
      ? BRIEF_ASSIST_DOING[assist.intent]
      : r.live === "waiting"
        ? r.approval
          ? "Waiting for approval"
          : "Needs you"
        : r.live === "failed"
          ? "Stopped"
          : "Replied";
  const steps = r.steps ?? [];
  return (
    <div className="brief-asked" data-live={r.live} data-busy={busy || undefined}>
      <Link href={`/chat/${encodeURIComponent(r.sessionId)}`} className="brief-asked-line">
        <SparkleIcon className="h-4 w-4" />
        <span className="min-w-0">
          <b>{word}</b>
          {hasNext ? <span className="brief-asked-next"> {r.next}</span> : null}
          <span className="sr-only">: {title}. Opens the conversation.</span>
        </span>
        <ChevronIcon className="h-4 w-4" />
      </Link>
      {steps.length ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="brief-fold"
            aria-expanded={open}
            icon={<ChevronIcon className="h-3.5 w-3.5" />}
            onClick={() => setOpen((v) => !v)}
          >
            {steps.length === 1 ? "1 more step" : `${steps.length} more steps`}
            <span className="sr-only">: {title}</span>
          </Button>
          {open ? (
            <ol className="brief-asked-steps">
              {steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Row({ row, actions }: { row: BriefDeckRow; actions?: BriefActions }) {
  const online = useOnline();
  const assist = row.assist;
  const starting = Boolean(
    assist && actions?.assist.isPending && actions.assist.variables?.kind === assist.target.kind && actions.assist.variables.id === assist.target.id,
  );
  const body = (
    <>
      <span className="brief-deck-mark" aria-hidden="true">
        {row.done ? <CheckIcon className="h-3 w-3" /> : null}
      </span>
      <span className="min-w-0">
        <span className="brief-deck-t">{row.title}</span>
        {rowMeta(row) ? (
          <span className="brief-deck-m" data-dynamic>
            {rowMeta(row)}
          </span>
        ) : null}
        {row.done ? <span className="sr-only"> (done)</span> : null}
      </span>
    </>
  );
  return (
    <li data-done={row.done || undefined}>
      {row.href && row.external ? (
        <a href={row.href} target="_blank" rel="noreferrer noopener" className="brief-deck-row">
          {body}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : row.href ? (
        <Link href={row.href} className="brief-deck-row">
          {body}
        </Link>
      ) : (
        <span className="brief-deck-row">{body}</span>
      )}
      {assist?.request ? (
        <Asked title={row.title} assist={assist} />
      ) : assist && actions ? (
        <Button
          variant="ghost"
          size="sm"
          className="brief-spark"
          data-starting={starting || undefined}
          icon={<SparkleIcon className="h-3.5 w-3.5" />}
          loading={starting}
          disabled={!online || (actions.assist.isPending && !starting)}
          onClick={() => actions.assist.mutate(assist.target)}
        >
          {starting ? BRIEF_ASSIST_DOING[assist.intent] : BRIEF_ASSIST_LABEL[assist.intent]}
          <span className="sr-only">: {row.title}</span>
        </Button>
      ) : null}
    </li>
  );
}

function Card({ card, actions }: { card: BriefDeckCard; actions?: BriefActions }) {
  const label = BRIEF_DECK_LABEL[card.kind];
  const rest = card.total - card.rows.length;
  return (
    <article className="brief-deck-card" data-kind={card.kind}>
      <p className="brief-deck-top">
        <span className="brief-kind">{label}</span>
        <span className="brief-deck-n" data-dynamic>
          {card.total}
        </span>
      </p>
      <ul className="brief-deck-rows">
        {card.rows.map((r) => (
          <Row key={r.id} row={r} actions={actions} />
        ))}
      </ul>
      {card.more ? (
        <Link href={card.more} className="brief-deck-more">
          {rest > 0 ? `${rest} more` : "See all"}
          <span className="sr-only">: {label}</span>
          <ChevronIcon className="h-4 w-4" />
        </Link>
      ) : rest > 0 ? (
        <p className="brief-deck-more">{rest} more</p>
      ) : null}
    </article>
  );
}

/**
 * Everything that is not one of the top few things, as three rows of cards:
 * Next up (Urgent, Decisions), Initiatives (Habits, In progress) and Coming up
 * (On the calendar, Low priority). `only` renders one of the rows, so the page
 * can put Insights between them. A row with nothing in it is not shown.
 */
export function BriefDeck({ deck, only, actions }: { deck: BriefDeckCard[]; only?: (typeof BRIEF_DECK_GROUPS)[number][]; actions?: BriefActions }) {
  return (
    <>
      {BRIEF_DECK_GROUPS.filter((g) => !only || only.includes(g)).map((g) => {
        const cards = deck.filter((d) => BRIEF_DECK_GROUP_OF[d.kind] === g);
        if (!cards.length) return null;
        return (
          <Carousel
            key={g}
            id={`brief-row-${g}`}
            title={BRIEF_DECK_GROUP_LABEL[g]}
            testId={`brief-row-${g}`}
            slides={cards.map((c) => ({ key: c.kind, label: BRIEF_DECK_LABEL[c.kind], node: <Card card={c} actions={actions} /> }))}
          />
        );
      })}
    </>
  );
}
