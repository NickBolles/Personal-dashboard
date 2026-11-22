"use client";

import { useRouter } from "next/navigation";
import type { AssistCard as Assist } from "@/lib/contracts";
import { AgentSurface, Button } from "@/components/ui";
import { chatHref } from "./chat";
import { FeedbackBar } from "./Feedback";

const ORIGIN_LABEL: Record<Assist["origin"], string> = {
  data: "Suggestion from your data",
  milestone: "From a date you saved",
  calendar: "From your calendar",
  seasonal: "Seasonal idea",
};

/**
 * A deterministic suggestion (task threads H8): costs nothing, never calls a model, and uses the same agent
 * surface as a coordinator's. The label says where it came from; the chat action only opens a prefilled,
 * read-only planning conversation.
 */
export function AssistCard({ card, onTriage }: { card: Assist; onTriage: (card: Assist) => void }) {
  const router = useRouter();
  const chat = card.chat;
  const primary = card.triage
    ? { label: "Review & reschedule", onClick: () => onTriage(card) }
    : chat
      ? { label: chat.label, onClick: () => router.push(chatHref(chat)) }
      : undefined;
  return (
    <AgentSurface
      variant="proposed"
      testId="assist-card"
      who={ORIGIN_LABEL[card.origin]}
      title={card.title}
      why={card.body}
      primary={primary}
      actions={
        card.triage && chat ? (
          <Button size="sm" variant="ghost" onClick={() => router.push(chatHref(chat))}>
            {chat.label}
          </Button>
        ) : null
      }
      more={
        <>
          <ul className="k-surface-list">
            <li>{card.basis}</li>
            {card.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
            {chat ? <li>The chat opens with a draft. Hermes only runs when you press send, and it’s told not to change anything.</li> : null}
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
        </>
      }
    />
  );
}
