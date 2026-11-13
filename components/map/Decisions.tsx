"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, EmptyState, StateWord, ThingRow, useNow, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";
import { DecisionNotices, DecisionReceiptLine, DecisionThing, type AskAbout } from "@/components/decisions/DecisionBlock";
import { INBOX_KEY, isReceipt, useDecisionFlow, useInboxDecisions, withReceipts, type DecisionReceipt } from "@/components/decisions/useAnswerDecision";
import "./map.css";
import { sortByUrgency } from "@/lib/cw-decisions";
import { decisionLogText, type DecisionEntry } from "@/lib/decisions";
import { viewOfEntry, type DecisionView } from "@/lib/decision-view";
import { ageLabel } from "@/lib/coordinator/needs";
import { plainStatusWords } from "@/lib/chat/display";

export const DECISIONS_KEY = INBOX_KEY;
/** The "Needs you" list (sidebar badge, /decisions, Map and Today). */
export const useDecisions = useInboxDecisions;

type PostOffer = { sessionId: string; coordinator: boolean; text: string };

const seqOf = (ref: string) => Number(ref.slice(2)) || 0;

/** Decisions first in the queue's own urgency order, then what waits on a tap elsewhere, then work that went silent. */
export function orderEntries(entries: DecisionEntry[], now = new Date()) {
  const decisions = sortByUrgency(
    entries.flatMap((entry) => {
      const view = viewOfEntry(entry);
      return view ? [{ ...view, seq: seqOf(view.ref), entry }] : [];
    }),
    now,
  );
  const drawn = new Set(decisions.map((d) => d.entry.key));
  const rest = entries.filter((e) => !drawn.has(e.key));
  return { decisions, waiting: rest.filter((e) => e.kind !== "stalled"), stalled: rest.filter((e) => e.kind === "stalled") };
}

/**
 * The "Needs you" list: one row per thing, in one order. A decision is the shared decision block (row, card in
 * place, receipt: components/decisions); an approval or a workflow proposal is a row that opens where it is
 * answered (never settled from here); a run that stopped reporting is a row with the word Stalled.
 */
export function DecisionsList({
  entries,
  emptyText,
  emptyHint,
  onAsk,
}: {
  entries: DecisionEntry[];
  emptyText?: string;
  /** Page-level empty state (kit EmptyState) instead of the compact one-line note. */
  emptyHint?: string;
  onAsk?: AskAbout;
}) {
  // A receipt outlives its Undo here while it still offers to post the answer to the item's conversation.
  const { flow, shared } = useDecisionFlow({ keepReceipts: true });
  const now = useNow();
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [offers, setOffers] = useState<Record<string, PostOffer>>({});
  const { decisions, waiting, stalled } = orderEntries(entries, new Date(now));
  const shown = (receipt: DecisionReceipt) => receipt.undoable || !!offers[receipt.view.ref];
  const receipts = Object.fromEntries(Object.entries(flow.receipts).filter(([, receipt]) => shown(receipt)));
  const rows = withReceipts<DecisionView & { entry: DecisionEntry }>(decisions, receipts);
  const dropOffer = (ref: string) =>
    setOffers((all) => {
      const copy = { ...all };
      delete copy[ref];
      return copy;
    });
  // The open card pages through the decisions still waiting, in the list's order.
  const openRefs = rows.flatMap((row) => (isReceipt(row) ? [] : [row.ref]));
  const pagerOf = (ref: string) => {
    const index = openRefs.indexOf(ref);
    return {
      index,
      total: openRefs.length,
      onPrev: index > 0 ? () => setOpenRef(openRefs[index - 1]) : undefined,
      onNext: index < openRefs.length - 1 ? () => setOpenRef(openRefs[index + 1]) : undefined,
    };
  };
  const empty = !rows.length && !waiting.length && !stalled.length;
  return (
    <>
      {empty ? (
        emptyHint ? (
          <div data-testid="decisions-empty">
            <EmptyState title={emptyText ?? "Nothing needs you right now."}>{emptyHint}</EmptyState>
          </div>
        ) : (
          <p className="text-sm text-muted" data-testid="decisions-empty">
            {emptyText ?? "Nothing needs you right now."}
          </p>
        )
      ) : (
        <ul className="dcs-list" data-testid="decisions-list">
          {rows.map((row) =>
            isReceipt(row) ? (
              <li key={row.view.ref}>
                <DecisionReceiptLine
                  receipt={row}
                  action={offers[row.view.ref] ? <PostAnswer offer={offers[row.view.ref]} onPosted={() => dropOffer(row.view.ref)} /> : undefined}
                  onUndo={() => {
                    // #167: taking the answer back withdraws the offer to post it.
                    void flow.undo(row.view.ref).then((undone) => {
                      if (undone) dropOffer(row.view.ref);
                    });
                  }}
                />
              </li>
            ) : (
              <li key={row.ref}>
                <DecisionThing
                  view={row}
                  flow={flow}
                  now={now}
                  index={decisions.findIndex((d) => d.ref === row.ref)}
                  open={openRef === row.ref}
                  onToggle={(ref, open) => setOpenRef(open ? ref : null)}
                  pager={pagerOf(row.ref)}
                  onAsk={onAsk}
                  onAnswered={(result, choice) => {
                    const e = row.entry;
                    const sessionId = e.sessionId ?? e.coordinatorSessionId ?? null;
                    if (!sessionId || !result.op) return;
                    const text = `Decision on "${e.title}": ${decisionLogText(e.question, choice)}`;
                    setOffers((all) => ({ ...all, [row.ref]: { sessionId, coordinator: !e.sessionId, text } }));
                  }}
                />
              </li>
            ),
          )}
          {[...waiting, ...stalled].map((e) => (
            <li key={e.key}>
              <OtherRow entry={e} now={now} />
            </li>
          ))}
        </ul>
      )}
      {!shared ? <DecisionNotices notices={flow.notices} /> : null}
    </>
  );
}

/** Where a row that is not a decision opens, in words (the row says it before the tap). */
function opensWhere(e: DecisionEntry) {
  if (e.kind === "approval") return "opens the conversation";
  if (e.kind === "workflow") return e.href.startsWith("/chat/") ? "opens the conversation" : "opens Workflows";
  return "opens the item";
}

/** An approval, a workflow proposal or a stalled run: same row shape; it opens where it is dealt with. */
function OtherRow({ entry: e, now }: { entry: DecisionEntry; now: number }) {
  const question = plainStatusWords(e.question);
  const stalled = e.kind === "stalled";
  // An approval has no title of its own: what the run wants to do is the headline.
  const title = e.kind === "approval" ? question : e.title;
  const kind = e.kind === "approval" ? "Approval" : e.kind === "workflow" ? "Workflow" : e.kind === "item" ? "Decision" : null;
  return (
    <ThingRow
      className="dcs-row"
      data-testid="decision-row"
      data-kind={e.kind}
      state={stalled ? "stalled" : "needs"}
      refId={e.runRef ?? undefined}
      title={<span className="dcs-wrap">{title}</span>}
      sub={
        <span className="dcs-meta">
          {stalled ? (
            <span>
              <StateWord state="stalled" />
            </span>
          ) : null}
          {kind ? <span>{kind}</span> : null}
          {e.kind !== "approval" ? <span>{question}</span> : null}
          <span>{opensWhere(e)}</span>
          {stalled ? null : <span>{ageLabel(e.at, now)}</span>}
        </span>
      }
      href={e.href}
    />
  );
}

/**
 * The quiet follow-up on a receipt: post the answer to the item's conversation (or the area's coordinator chat),
 * so the agent there picks it up. Only on this explicit tap; undoing the answer withdraws it.
 */
function PostAnswer({ offer, onPosted }: { offer: PostOffer; onPosted: () => void }) {
  const { toast } = useToast();
  const post = useMutation({
    mutationFn: () =>
      api.post(`/api/hermes/sessions/${encodeURIComponent(offer.sessionId)}/runs`, {
        input: offer.text,
        idempotencyKey: `decision-${offer.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      }),
    onSuccess: () => (toast("Posted to the conversation"), onPosted()),
    onError: (err) => toast(`Not posted: ${(err as Error).message}`, "danger"),
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      className="dcs-post"
      data-testid="decision-post"
      title={offer.text}
      loading={post.isPending}
      onClick={() => post.mutate()}
    >
      {offer.coordinator ? "Post to coordinator" : "Post to conversation"}
    </Button>
  );
}

/** "Needs you" section for Today and Map; renders nothing until there is something to show. */
export function NeedsYouSection({ entries, id = "needs-you-h", limit }: { entries?: DecisionEntry[]; id?: string; limit?: number }) {
  const access = useAccess();
  const q = useDecisions(entries === undefined && (access.can("work.use") || access.can("hermes.chat")));
  const list = entries ?? q.data?.entries ?? [];
  // Once shown, stay mounted so answering the last entry keeps its receipt and Undo.
  const [shownOnce, setShownOnce] = useState(false);
  if (list.length && !shownOnce) setShownOnce(true);
  if (!list.length && !shownOnce) return null;
  // The first few in the list's own order (decisions by urgency), not the first few that happened to arrive.
  const ordered = orderEntries(list);
  const sorted = [...ordered.decisions.map((d) => d.entry), ...ordered.waiting, ...ordered.stalled];
  const shown = limit ? sorted.slice(0, limit) : sorted;
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
      <DecisionsList entries={shown} />
    </section>
  );
}
