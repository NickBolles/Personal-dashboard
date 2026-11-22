"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, useNow } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { SessionSummary, TimelineItem } from "@/lib/hermes";
import { shortWhen } from "@/lib/task-state";

export type EarlierThread = { id: string; title: string; lastActiveAt: string | null };
type Message = Extract<TimelineItem, { kind: "user" | "assistant" }>;

/** "Furnace planning · 18 Nov": the thread's name and when it was last active. */
const label = (t: EarlierThread, now: number) => [t.title, shortWhen(t.lastActiveAt, now)].filter(Boolean).join(" · ");

/**
 * A bot's earlier threads, as the top of one continuous chat: each is a grey divider (its title and date) and its
 * messages, greyed and read-only. Nothing folds. The divider above the oldest one shown loads the one before it; a
 * thread's own divider, tapped, continues that thread. `threads` is newest first; the `shown` newest are drawn,
 * oldest at the top.
 */
export function EarlierThreads({
  threads,
  shown,
  onMore,
  render,
  current,
  onContinue,
}: {
  threads: readonly EarlierThread[];
  shown: number;
  onMore: () => void;
  /** Draws one message the way the chat does (the same text renderer, without its actions). */
  render: (m: Message) => ReactNode;
  /** The name of the thread below them (the one you are in): its divider closes the history. */
  current: string;
  /** Continue an earlier thread: the chat moves to it. */
  onContinue?: (id: string) => void;
}) {
  const now = useNow();
  if (!threads.length) return null;
  const drawn = threads.slice(0, shown).reverse();
  const next = threads[shown];
  return (
    <div className="gc-earlier" data-testid="gc-earlier">
      {next ? (
        <Button variant="ghost" size="sm" className="gc-earlier-div gc-earlier-more" onClick={onMore} data-testid="gc-earlier-more">
          <span>Earlier · {label(next, now)}</span>
        </Button>
      ) : null}
      {drawn.map((t) => (
        <EarlierThreadBlock key={t.id} thread={t} title={label(t, now)} render={render} onContinue={onContinue} />
      ))}
      {drawn.length ? (
        <div role="separator" aria-label={current} className="gc-earlier-div">
          <span>{current}</span>
        </div>
      ) : null}
    </div>
  );
}

function EarlierThreadBlock({
  thread,
  title,
  render,
  onContinue,
}: {
  thread: EarlierThread;
  title: string;
  render: (m: Message) => ReactNode;
  onContinue?: (id: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["session", thread.id],
    queryFn: ({ signal }) => api.get<{ session: SessionSummary; timeline: TimelineItem[] }>(`/api/hermes/sessions/${encodeURIComponent(thread.id)}`, signal),
    staleTime: 60_000,
  });
  const messages = (detail.data?.timeline ?? []).filter((m): m is Message => (m.kind === "user" || m.kind === "assistant") && !!m.text.trim());
  return (
    <section aria-label={`Earlier thread: ${title}`} className="gc-earlier-thread" data-thread={thread.id}>
      {onContinue ? (
        <Button variant="ghost" size="sm" className="gc-earlier-div gc-earlier-more" aria-label={`Continue ${title}`} onClick={() => onContinue(thread.id)}>
          <span>{title}</span>
        </Button>
      ) : (
        <div role="separator" aria-label={title} className="gc-earlier-div">
          <span>{title}</span>
        </div>
      )}
      {detail.isLoading ? <p className="gc-earlier-note">Loading…</p> : null}
      {detail.error ? <p className="gc-earlier-note">Couldn&apos;t load this thread</p> : null}
      {detail.isSuccess && !messages.length ? <p className="gc-earlier-note">No messages</p> : null}
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
