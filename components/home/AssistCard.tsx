"use client";

import { useState } from "react";
import type { AssistCard as Assist } from "@/lib/contracts";
import { Button, ButtonLink, cx } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { chatHref } from "./chat";
import { FeedbackBar } from "./Feedback";
import { TriageDialog } from "./TriageDialog";

const ORIGIN_LABEL: Record<Assist["origin"], string> = {
  data: "Suggestion from your data",
  milestone: "From a date you saved",
  calendar: "From your calendar",
  seasonal: "Seasonal idea",
};

const TONE_BAR: Record<Assist["tone"], string> = {
  warn: "overdue_recent",
  accent: "compass",
  neutral: "today",
};

/**
 * A deterministic suggestion. The label says where it came from; the chat
 * button only opens a prefilled, read-only planning conversation.
 */
export function AssistCard({ card }: { card: Assist }) {
  const [triage, setTriage] = useState(false);
  const titleId = `assist-${card.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <article aria-labelledby={titleId} data-tier={TONE_BAR[card.tone]} className="card jv-accent jv-rise flex flex-col gap-2 p-4 pl-5">
      <p className={cx("text-xs font-medium", card.origin === "seasonal" ? "text-muted" : "text-[var(--tier-compass)]")}>{ORIGIN_LABEL[card.origin]}</p>
      <h3 id={titleId} className="text-base font-semibold leading-snug">
        {card.title}
      </h3>
      <p className="text-sm text-muted">{card.body}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        {card.triage ? (
          <Button variant="primary" size="sm" onClick={() => setTriage(true)} aria-describedby={titleId}>
            Review &amp; reschedule
          </Button>
        ) : null}
        {card.chat ? (
          <ButtonLink href={chatHref(card.chat)} variant={card.triage ? "secondary" : "primary"} className="min-h-11 text-sm" aria-describedby={titleId}>
            {card.chat.label}
          </ButtonLink>
        ) : null}
      </div>
      <details className="jv-why group -mx-1">
        <summary className="tap inline-flex items-center gap-1 rounded-[8px] px-1 text-xs font-medium text-muted hover:text-text">
          <span>Why am I seeing this?</span>
          <span className="sr-only"> ({card.title})</span>
          <ChevronIcon className="h-4 w-4 transition-transform group-open:rotate-90" />
        </summary>
        <div className="jv-rise space-y-3 px-1 pb-1 pt-1">
          <ul className="space-y-0.5 text-sm text-muted">
            <li>· {card.basis}</li>
            {card.why.map((w) => (
              <li key={w}>· {w}</li>
            ))}
            {card.chat ? <li>· The chat opens with a draft. Hermes only runs when you press send, and it’s told not to change anything.</li> : null}
          </ul>
          <FeedbackBar
            rate
            target={{
              kind: "assist",
              id: card.id,
              category: card.category,
              title: card.title,
              fingerprint: card.provenance.fingerprint,
              why: [card.basis, ...card.why],
              sources: card.provenance.sources,
            }}
          />
        </div>
      </details>
      {card.triage ? <TriageDialog open={triage} onClose={() => setTriage(false)} items={card.triage.items} chat={card.chat} /> : null}
    </article>
  );
}
