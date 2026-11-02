"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, useToast } from "@/components/ui";
import { Button, ChipButton, Pill } from "@/components/ui/kit";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { useAccess } from "@/components/access";
import "./map.css";
import { decisionLogText, type DecisionEntry, type DecisionsResponse } from "@/lib/decisions";

export const DECISIONS_KEY = ["work", "decisions"] as const;

/** The "Needs you" list (sidebar badge, /decisions, Map and Today). */
export function useDecisions(enabled = true) {
  // Approvals and workflow proposals change outside work mutations (Hermes
  // events, the chat approval handler), so poll while the app is visible.
  return useQuery({
    queryKey: DECISIONS_KEY,
    queryFn: () => api.get<DecisionsResponse>("/api/work/decisions"),
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

const KIND_LABEL: Record<DecisionEntry["kind"], string> = { item: "Decision", approval: "Approval", workflow: "Workflow" };

/**
 * One row per open decision. Item decisions are answered in place (a choice
 * button or a short answer); the answer is logged as activity, appended to the
 * item and undoable. If the item has a Hermes conversation, posting the answer
 * there is offered afterwards and only happens on an explicit tap. Approvals and
 * workflow proposals open where they are answered (never auto-settled).
 */
export function DecisionsList({ entries, compact, emptyText }: { entries: DecisionEntry[]; compact?: boolean; emptyText?: string }) {
  const [op, setOp] = useState<UndoOp | null>(null);
  const [posted, setPosted] = useState<{ key: string; sessionId: string; text: string } | null>(null);
  // Undo and "post to conversation" stay mounted after the last entry is answered.
  return (
    <>
      {posted ? <PostConfirm key={posted.key} sessionId={posted.sessionId} text={posted.text} onDone={() => setPosted(null)} /> : null}
      {entries.length ? (
        <ul className="dc-list" data-testid="decisions-list">
          {entries.map((e) => (
            <DecisionRow
              key={e.key}
              entry={e}
              compact={compact}
              onAnswered={(o, text) => (setOp(o), e.sessionId ? setPosted({ key: e.key, sessionId: e.sessionId, text }) : null)}
            />
          ))}
        </ul>
      ) : posted ? null : (
        <p className="text-sm text-muted" data-testid="decisions-empty">
          {emptyText ?? "Nothing needs you right now."}
        </p>
      )}
      {op ? <UndoBar key={op.id} op={op} onDone={() => setOp(null)} /> : null}
    </>
  );
}

function DecisionRow({ entry: e, compact, onAnswered }: { entry: DecisionEntry; compact?: boolean; onAnswered: (op: UndoOp, text: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const answer = useMutation({
    mutationFn: (a: string) => api.post<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(e.itemId!)}/decision`, { answer: a }),
    onSuccess: (r, a) => {
      toast("Answered");
      if (r.op) onAnswered(r.op, `Decision on "${e.title}": ${decisionLogText(e.question, a)}`);
    },
    onError: (err) => toast(`Not saved: ${(err as Error).message}`, "danger"),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ["work"] }), qc.invalidateQueries({ queryKey: ["activity"] })]),
  });
  const qid = `dc-q-${e.key.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <li className="dc-row" data-testid="decision-row" aria-labelledby={qid}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Pill tone={e.kind === "approval" ? "wn" : e.kind === "workflow" ? "ai" : "ac"}>{KIND_LABEL[e.kind]}</Pill>
        {e.itemId ? (
          <Link href={e.href} className="min-w-0 truncate text-[13px] font-medium hover:underline">
            {e.title}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-[13px] font-medium">{e.title}</span>
        )}
        {e.areaTitle && !compact ? <span className="text-xs text-muted">{e.areaTitle}</span> : null}
      </div>
      <p id={qid} className="mt-1 text-sm break-words">
        {e.question}
      </p>
      {e.kind === "item" ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={`Answer: ${e.question}`}>
          {e.choices.map((c) => (
            <ChipButton key={c} disabled={answer.isPending} onClick={() => answer.mutate(c)}>
              {c}
            </ChipButton>
          ))}
          <form
            className="flex min-w-0 flex-1 basis-48 items-center gap-1.5"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (text.trim()) answer.mutate(text.trim());
            }}
          >
            <label htmlFor={`${qid}-a`} className="sr-only">
              Short answer
            </label>
            <input
              id={`${qid}-a`}
              className="k-pick min-w-0 flex-1 px-2"
              value={text}
              maxLength={2000}
              placeholder={e.choices.length ? "Or type an answer" : "Type an answer"}
              onChange={(ev) => setText(ev.target.value)}
            />
            <Button type="submit" size="sm" variant="primary" disabled={!text.trim()} loading={answer.isPending}>
              Answer
            </Button>
          </form>
        </div>
      ) : (
        <div className="mt-2">
          <Link href={e.href} className="k-pick inline-flex items-center px-3 text-[13px]">
            {e.kind === "approval" ? "Open the conversation to approve or deny" : "Review proposals"}
          </Link>
        </div>
      )}
    </li>
  );
}

/** Explicit confirm before an answer is posted to the item's Hermes conversation (writes confirmed). */
function PostConfirm({ sessionId, text, onDone }: { sessionId: string; text: string; onDone: () => void }) {
  const { toast } = useToast();
  const post = useMutation({
    mutationFn: () =>
      api.post(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/runs`, {
        input: text,
        idempotencyKey: `decision-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      }),
    onSuccess: () => (toast("Posted to the conversation"), onDone()),
    onError: (err) => toast(`Not posted: ${(err as Error).message}`, "danger"),
  });
  return (
    <div role="group" aria-label="Post your answer to the conversation?" className={cx("dc-confirm mb-2")} data-testid="decision-post-confirm">
      <p className="text-sm">This item has a Hermes conversation. Post your answer there too?</p>
      <p className="mt-1 text-xs break-words text-muted">{text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={post.isPending} onClick={() => post.mutate()}>
          Post to conversation
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/** "Needs you" section for Today and Map; renders nothing until there is something to show. */
export function NeedsYouSection({ entries, id = "needs-you-h", limit }: { entries?: DecisionEntry[]; id?: string; limit?: number }) {
  const access = useAccess();
  const q = useDecisions(entries === undefined && (access.can("work.use") || access.can("hermes.chat")));
  const list = entries ?? q.data?.entries ?? [];
  // Once shown, stay mounted so answering the last entry keeps its Undo / post controls.
  const [shownOnce, setShownOnce] = useState(false);
  if (list.length && !shownOnce) setShownOnce(true);
  if (!list.length && !shownOnce) return null;
  const shown = limit ? list.slice(0, limit) : list;
  return (
    <section aria-labelledby={id} className="mb-5" data-testid="needs-you">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h2 id={id} className="wk-label">
          Needs you <span className="text-muted">· {list.length}</span>
        </h2>
        {limit && list.length > limit ? (
          <Link href="/decisions" className="text-xs text-muted hover:underline">
            All {list.length}
          </Link>
        ) : null}
      </div>
      <DecisionsList entries={shown} compact />
    </section>
  );
}
