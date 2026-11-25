"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, useNow } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { SessionSummary, TimelineItem } from "@/lib/hermes";
import { shortWhen } from "@/lib/task-state";

export type EarlierThread = { id: string; title: string; lastActiveAt: string | null };
type Message = Extract<TimelineItem, { kind: "user" | "assistant" }>;

/**
 * A bot's earlier threads, as the top of one continuous chat. Nothing folds and nothing else is offered: a grey
 * "Earlier" divider loads the thread before; each thread drawn starts with a hairline showing when it was, then its
 * messages, greyed and read-only. `threads` is newest first; the `shown` newest are drawn, oldest at the top.
 */
export function EarlierThreads({
  threads,
  shown,
  onMore,
  render,
}: {
  threads: readonly EarlierThread[];
  shown: number;
  onMore: () => void;
  /** Draws one message the way the chat does (the same text renderer, without its actions). */
  render: (m: Message) => ReactNode;
}) {
  const now = useNow();
  if (!threads.length) return null;
  const drawn = threads.slice(0, shown).reverse();
  return (
    <div className="gc-earlier" data-testid="gc-earlier">
      {shown < threads.length ? (
        <Button variant="ghost" size="sm" className="gc-earlier-div gc-earlier-more" onClick={onMore} data-testid="gc-earlier-more">
          <span>Earlier</span>
        </Button>
      ) : null}
      {drawn.map((t) => (
        <EarlierThreadBlock key={t.id} thread={t} when={shortWhen(t.lastActiveAt, now)} render={render} />
      ))}
      {/* Where the thread you are in begins. */}
      {drawn.length ? <div role="separator" aria-label="This thread" className="gc-earlier-div" /> : null}
    </div>
  );
}

function EarlierThreadBlock({ thread, when, render }: { thread: EarlierThread; when: string; render: (m: Message) => ReactNode }) {
  const detail = useQuery({
    queryKey: ["session", thread.id],
    queryFn: ({ signal }) => api.get<{ session: SessionSummary; timeline: TimelineItem[] }>(`/api/hermes/sessions/${encodeURIComponent(thread.id)}`, signal),
    staleTime: 60_000,
  });
  const messages = (detail.data?.timeline ?? []).filter((m): m is Message => (m.kind === "user" || m.kind === "assistant") && !!m.text.trim());
  return (
    <section aria-label={`Earlier thread: ${thread.title}`} className="gc-earlier-thread" data-thread={thread.id}>
      <div role="separator" aria-label={when || thread.title} className="gc-earlier-div">
        {when ? <span>{when}</span> : null}
      </div>
      {detail.isLoading ? <p className="gc-earlier-note">Loading…</p> : null}
      {detail.error ? <p className="gc-earlier-note">Couldn&apos;t load this thread</p> : null}
      {messages.length ? (
        <ol>
          {messages.map((m) => (
            <li key={m.id} className="co-msg" data-who={m.kind}>
              {render(m)}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
