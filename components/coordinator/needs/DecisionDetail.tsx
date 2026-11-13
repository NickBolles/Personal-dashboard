"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, useNow } from "@/components/ui";
import { DecisionCardView, DecisionNotices, DecisionReceiptLine, handleCardKey, useDecisionCard } from "@/components/decisions/DecisionBlock";
import type { Decision } from "@/lib/cw-decisions";
import { decisionKeyAction, deferUntil, nextAfterAnswer, pagerState } from "@/lib/coordinator/needs";
import { viewOfDecision, type DecisionView } from "@/lib/decision-view";
import { useDecisionFlow } from "./useCoordinatorDecisions";

type Props = { decisions: Decision[]; refId: string; onBack: () => void; onNavigate: (ref: string) => void; onAsk: (ref: string) => void; arm?: string };
/**
 * One decision in the Chief of staff panel: the shared card (components/decisions) paging through the queue
 * ("1 of N", j / k), and moving to the next decision 600 ms after an answer. The receipt keeps its Undo in the panel.
 */
export function DecisionDetail(props: Props) {
  // Navigation resets the armed choice; a previous decision's confirmation can never leak.
  return <Detail key={props.refId} {...props} />;
}
function Detail({ decisions, refId, onBack, onNavigate, onAsk, arm }: Props) {
  const { flow, shared } = useDecisionFlow();
  const current = decisions.find((d) => d.ref === refId && d.state === "open");
  const receipt = flow.receipts[refId];
  // The answer leaves the queue at once (optimistic); what was on screen is held so the pane does not blank.
  const [held, setHeld] = useState<{ view: DecisionView; list: Decision[] } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Decision[]>(decisions);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    root.current?.focus({ preventScroll: true });
    // The list may have been scrolled far down: the decision starts at its title bar, not mid-card.
    root.current?.scrollIntoView?.({ block: "start" });
    return () => {
      mounted.current = false;
      if (advance.current) clearTimeout(advance.current);
    };
  }, []);
  const view = current ? viewOfDecision(current) : (held?.view ?? receipt?.view ?? null);
  const now = useNow();
  const cancelAdvance = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
  };
  const base = useDecisionCard(view, flow, {
    arm,
    index: Math.max(
      0,
      decisions.findIndex((d) => d.ref === refId),
    ),
    onAnswered: () => {
      if (!mounted.current) return;
      const list = queue.current;
      advance.current = setTimeout(() => {
        const next = nextAfterAnswer(list, refId);
        if (next) onNavigate(next);
        else onBack();
      }, 600);
    },
  });
  function hold() {
    if (!current || !view) return;
    queue.current = [...decisions];
    setHeld({ view, list: [...decisions] });
  }
  const card = {
    ...base,
    pick: (choice: string) => {
      hold();
      base.pick(choice);
    },
    confirm: () => {
      hold();
      base.confirm();
    },
  };
  const pager = pagerState(current ? decisions : (held?.list ?? decisions), refId);
  function go(ref: string | null) {
    cancelAdvance();
    if (ref) onNavigate(ref);
  }
  function back() {
    cancelAdvance();
    onBack();
  }
  async function undo() {
    cancelAdvance();
    if ((await flow.undo(refId)) && mounted.current) setHeld(null);
    onNavigate(refId);
  }
  function ask() {
    cancelAdvance();
    onAsk(refId);
  }
  function keyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (current && view && handleCardKey(e, view, card)) return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const target = e.target as HTMLElement;
    const typing = !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
    // Enter on a focused control (Cancel, Defer, a link) does what that control does.
    if (e.key === "Enter" && target !== root.current && target.closest("button, a")) return;
    const action = decisionKeyAction(e.key, { typing, canUndo: !!receipt?.undoable });
    if (!action) return;
    e.preventDefault();
    if (action === "next") go(pager.next);
    else if (action === "prev") go(pager.prev);
    else if (action === "back") back();
    else if (action === "ask") ask();
    else if (action === "defer" && current && !flow.busy(refId)) {
      card.cancel();
      flow.stageDefer(refId, deferUntil("hour"));
    } else if (action === "undo") void undo();
  }
  if (!view)
    return (
      <div className="gc-needs-detail min-w-0" ref={root} tabIndex={-1} onKeyDown={keyDown}>
        <Button size="sm" onClick={back} aria-label="Back to Needs you">
          Back
        </Button>
        <p>{refId} was already answered</p>
        {!shared ? <DecisionNotices notices={flow.notices} /> : null}
      </div>
    );
  return (
    <div className="gc-needs-detail min-w-0" ref={root} tabIndex={-1} onKeyDown={keyDown} data-ref={refId}>
      {receipt ? (
        <DecisionReceiptLine
          receipt={receipt}
          onUndo={() => {
            void undo();
          }}
        />
      ) : (
        <DecisionCardView
          view={view}
          card={card}
          flow={flow}
          now={now}
          onAsk={ask}
          onClose={back}
          closeLabel="Back to Needs you"
          pager={{
            index: Math.max(0, pager.index),
            total: pager.total,
            onPrev: pager.prev ? () => go(pager.prev) : undefined,
            onNext: pager.next ? () => go(pager.next) : undefined,
          }}
          nextRef={current ? nextAfterAnswer(decisions, refId) : null}
        />
      )}
      {!shared ? <DecisionNotices notices={flow.notices} /> : null}
    </div>
  );
}
