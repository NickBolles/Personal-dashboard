"use client";

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Button, EmptyState, Skeleton } from "@/components/ui";
import { DecisionNotices, DecisionReceiptLine } from "@/components/decisions/DecisionBlock";
import { DecisionDetail } from "./DecisionDetail";
import { NeedsList } from "./NeedsList";
import { DecisionFlowContext, useCoordinatorDecisions, useDecisionFlow, type NeedsOpenOptions } from "./useCoordinatorDecisions";

type Props = {
  onAsk: (ref: string, question: string) => void;
  initialRef?: string;
  onCount?: (n: number) => void;
  /** Shown with the list, above it (run approvals block live work); never beside an open decision on a narrow panel. */
  lead?: ReactNode;
  /** Approvals or runs to check are listed in `lead`: an empty decision queue must not say "Nothing needs you". */
  hasOther?: boolean;
};
export function NeedsPanel({ onAsk, initialRef, onCount, lead, hasOther }: Props) {
  const query = useCoordinatorDecisions();
  // One flow for the list and the detail: a receipt and its Undo survive moving between them. The panel host
  // shares its own when it has one, so an answer typed in the Chat composer leaves its receipt here too.
  const { flow } = useDecisionFlow();
  const [selected, setSelected] = useState<{ ref: string; arm?: string; visit: number } | null>(() => (initialRef ? { ref: initialRef, visit: 0 } : null));
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  const decisions = query.data?.decisions ?? [];
  const reportCount = useEffectEvent((n: number) => onCount?.(n));
  const count = query.data?.counts.open;
  useEffect(() => {
    if (count !== undefined) reportCount(count);
  }, [count]);
  useEffect(() => {
    if (!query.data) return;
    const first = !primed.current;
    primed.current = true;
    const incoming = query.data.decisions.filter((d) => !seen.current.has(d.ref));
    incoming.forEach((d) => seen.current.add(d.ref));
    // The queue that was already there when the panel opened is not news.
    if (incoming.length && !first) {
      setAnnouncement(incoming.map((d) => `New decision ${d.ref}`).join(". "));
    }
  }, [query.data]);
  function ask(ref: string) {
    const d = decisions.find((row) => row.ref === ref);
    onAsk(ref, d?.question ?? flow.receipts[ref]?.view.question ?? ref);
  }
  function open(ref: string, options?: NeedsOpenOptions) {
    if (options?.ask) {
      ask(ref);
      return;
    }
    // A new visit remounts the detail, so a previous decision's armed choice never carries over.
    setSelected((was) => ({ ref, arm: options?.arm, visit: (was?.visit ?? 0) + 1 }));
  }
  /** Taking an answer back returns to the decision it reopened. */
  function undoAndReturn(ref: string) {
    void flow.undo(ref).then((undone) => {
      if (undone) open(ref);
    });
  }
  // With a decision open on a narrow panel the list is out of sight: its receipts follow the owner here.
  const floating = selected ? Object.values(flow.receipts).filter((r) => r.view.ref !== selected.ref) : [];
  return (
    <DecisionFlowContext.Provider value={flow}>
      <div className="gc-needs-panel min-w-0">
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
        {query.isPending ? (
          <div role="status" aria-label="Loading decisions" className="gc-needs-loading">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton />
                <Skeleton w="70%" />
              </div>
            ))}
          </div>
        ) : null}
        {query.isError ? (
          <p role="alert" className="gc-needs-error">
            Decisions couldn&apos;t load.{" "}
            <Button size="sm" variant="ghost" loading={query.isFetching} onClick={() => void query.refetch()}>
              Try again
            </Button>
          </p>
        ) : null}
        {!query.data && !query.isPending ? lead : null}
        {query.data ? (
          <div className="gc-needs-layout" data-detail={!!selected}>
            <div className="gc-needs-list-pane min-w-0">
              {lead}
              <NeedsList decisions={decisions} onOpen={open} hasOther={hasOther} />
            </div>
            <div className="gc-needs-detail-pane min-w-0">
              {selected ? (
                // What comes next is said by the card itself ("Moves to D-n after you answer") and its pager.
                <DecisionDetail
                  key={selected.visit}
                  decisions={decisions}
                  refId={selected.ref}
                  arm={selected.arm}
                  onBack={() => setSelected(null)}
                  onNavigate={(ref) => open(ref)}
                  onAsk={ask}
                />
              ) : (
                <EmptyState title="Choose a decision">See the question, consequences and evidence here.</EmptyState>
              )}
            </div>
          </div>
        ) : null}
        <DecisionNotices notices={flow.notices}>
          {floating.length
            ? floating.map((receipt) => (
                <DecisionReceiptLine key={receipt.view.ref} className="dcs-floating" receipt={receipt} onUndo={() => undoAndReturn(receipt.view.ref)} />
              ))
            : null}
        </DecisionNotices>
      </div>
    </DecisionFlowContext.Provider>
  );
}
