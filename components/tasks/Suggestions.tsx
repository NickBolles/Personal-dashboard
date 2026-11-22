"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentSurface, Button, SectionHeader, useToast } from "@/components/ui";
import { api } from "@/lib/client/api";
import { suggestionVerb, type Suggestion, type SuggestionAction, type SuggestionsResponse } from "@/lib/suggestions";
import "./task-list.css";

/** The suggestions to draw for a scope ("all" or a channel id): one per channel (H3). Reading never calls a model. */
export function useSuggestions(scope: string, enabled = true) {
  return useQuery({
    queryKey: ["work", "suggestions", scope],
    queryFn: ({ signal }) => api.get<SuggestionsResponse>(`/api/work/suggestions?scope=${encodeURIComponent(scope)}`, signal),
    enabled,
    refetchInterval: 60_000,
  });
}

/** A card's answer, with what Undo does for it. */
function useSuggestionAction() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: SuggestionAction }) =>
      api.post<{ suggestion: Suggestion | null }>(`/api/work/suggestions/${encodeURIComponent(id)}`, { action }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["work"] }),
    onError: (e) => toast(e instanceof Error ? e.message : "That didn't work. Try again.", "danger"),
  });
}

/** What Start or Send will do, in words: shown behind "Why this?" (H2). */
function whatItDoes(s: Suggestion) {
  if (s.act === "steer") return `Sends this to “${s.itemTitle ?? "the task"}”:`;
  if (s.itemId) return `Starts “${s.itemTitle ?? s.title}” in its chat with:`;
  return `Creates “${s.title}” in ${s.channelTitle} and starts it with:`;
}

type Receipt = { kind: "hidden" | "stopped"; s: Suggestion };

/**
 * One suggestion on the agent surface. Proposed: Start or Send, Not now, Why this? (the evidence, exactly what it
 * does, and "Don't suggest this"). Once started it is the done card, with Open task and Undo.
 */
export function SuggestionCard({ s, quiet, onReceipt }: { s: Suggestion; quiet?: boolean; onReceipt?: (r: Receipt) => void }) {
  const router = useRouter();
  const act = useSuggestionAction();
  const run = (action: SuggestionAction, then?: () => void) => act.mutate({ id: s.id, action }, { onSuccess: then });
  if (s.state === "started" && s.result) {
    const r = s.result;
    return (
      <AgentSurface
        variant="done"
        testId="suggestion-done"
        who={`${s.who} · just now`}
        title={s.act === "steer" ? `Sent to “${r.title}”` : `Started “${r.title}”`}
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => router.push(r.href)}>
              Open task
            </Button>
            {r.undoable ? (
              <Button size="sm" variant="ghost" loading={act.isPending} onClick={() => run("undo")}>
                Undo
              </Button>
            ) : null}
          </>
        }
      />
    );
  }
  return (
    <AgentSurface
      variant="proposed"
      testId="suggestion"
      quiet={quiet}
      who={`${s.who} suggests`}
      title={s.title}
      why={s.why}
      primary={{ label: suggestionVerb(s), busy: act.isPending && act.variables?.action === "start", onClick: () => run("start") }}
      actions={
        <Button size="sm" variant="ghost" onClick={() => run("not_now", () => onReceipt?.({ kind: "hidden", s }))}>
          Not now
        </Button>
      }
      more={
        <>
          {s.evidence.length ? <span>From: {s.evidence.map((e) => e.title).join(" · ")}</span> : null}
          <span>{whatItDoes(s)}</span>
          <span className="k-surface-brief">{s.brief}</span>
          <span>
            <Button size="sm" variant="ghost" onClick={() => run("stop_topic", () => onReceipt?.({ kind: "stopped", s }))}>
              Don&rsquo;t suggest this
            </Button>
          </span>
        </>
      }
    />
  );
}

/** The line left where a card was hidden or its kind turned off, with the way back. */
function ReceiptLine({ r, onDone }: { r: Receipt; onDone: () => void }) {
  const act = useSuggestionAction();
  return (
    <p className="sg-receipt" role="status">
      <span>{r.kind === "hidden" ? "Hidden for a week" : `No more like this in ${r.s.channelTitle}`}</span>
      <Button
        size="sm"
        variant="ghost"
        loading={act.isPending}
        onClick={() => act.mutate({ id: r.s.id, action: r.kind === "hidden" ? "show_again" : "allow_topic" }, { onSuccess: onDone })}
      >
        Undo
      </Button>
    </p>
  );
}

/**
 * "Suggested for you": one card per channel (In flight, a Tasks tab). Nothing when there is none. `quiet` where
 * the view already has its own primary action.
 */
export function Suggestions({ scope, quiet, heading = true }: { scope: string; quiet?: boolean; heading?: boolean }) {
  const q = useSuggestions(scope);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const list = q.data?.suggestions ?? [];
  const shown = list.filter((s) => !receipts.some((r) => r.s.id === s.id));
  if (!shown.length && !receipts.length) return null;
  return (
    <section className="sg" aria-label="Suggested for you" data-testid="suggestions">
      {heading ? <SectionHeader label="Suggested for you" /> : null}
      {shown.map((s) => (
        <SuggestionCard key={s.id} s={s} quiet={quiet} onReceipt={(r) => setReceipts((old) => [...old, r])} />
      ))}
      {receipts.map((r) => (
        <ReceiptLine key={r.s.id} r={r} onDone={() => setReceipts((old) => old.filter((x) => x !== r))} />
      ))}
    </section>
  );
}

/** A card a coordinator left in a chat with jarvis_suggest: read back, so it shows what it is now. */
export function ChatSuggestion({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["work", "suggestions", "one", id],
    queryFn: ({ signal }) => api.get<{ suggestion: Suggestion | null }>(`/api/work/suggestions/${encodeURIComponent(id)}`, signal),
  });
  const s = q.data?.suggestion;
  return s ? <SuggestionCard s={s} quiet /> : null;
}
