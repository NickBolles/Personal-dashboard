"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button, EmptyState, Skeleton } from "@/components/ui";
import { pagerState } from "@/lib/coordinator/needs";
import { DecisionDetail } from "./DecisionDetail";
import { DecisionNotices, NeedsList } from "./NeedsList";
import { DecisionFeedbackContext, useCoordinatorDecisions, useDecisionFeedbackController, type NeedsOpenOptions } from "./useCoordinatorDecisions";

type Props = { onAsk: (ref: string, question: string) => void; initialRef?: string; onCount?: (n: number) => void };
export function NeedsPanel({ onAsk, initialRef, onCount }: Props) {
  const query = useCoordinatorDecisions();
  const feedback = useDecisionFeedbackController();
  const [selected, setSelected] = useState<{ ref: string; arm?: string; visit: number } | null>(() => (initialRef ? { ref: initialRef, visit: 0 } : null));
  const visit = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef(new Set<string>());
  const decisions = query.data?.decisions ?? [];
  const reportCount = useEffectEvent((n: number) => onCount?.(n));
  const count = query.data?.counts.open;
  useEffect(() => {
    if (count !== undefined) reportCount(count);
  }, [count]);
  useEffect(() => {
    const incoming = query.data?.decisions.filter((d) => !seen.current.has(d.ref)) ?? [];
    incoming.forEach((d) => seen.current.add(d.ref));
    if (incoming.length) {
      setAnnouncement(incoming.map((d) => `New decision ${d.ref}`).join(". "));
    }
  }, [query.data]);
  function ask(ref: string) {
    const d = decisions.find((row) => row.ref === ref);
    onAsk(ref, d?.question ?? ref);
  }
  function open(ref: string, options?: NeedsOpenOptions) {
    if (options?.ask) {
      ask(ref);
      return;
    }
    visit.current += 1;
    setSelected({ ref, arm: options?.arm, visit: visit.current });
  }
  const nextRef = selected ? pagerState(decisions, selected.ref).next : null;
  const next = decisions.find((d) => d.ref === nextRef);
  return (
    <DecisionFeedbackContext.Provider value={feedback}>
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
        {query.isError ? <p role="alert">Decisions couldn&apos;t load. Retrying.</p> : null}
        {query.data ? (
          <div className="gc-needs-layout" data-detail={!!selected}>
            <div className="gc-needs-list-pane min-w-0">
              <NeedsList decisions={decisions} onOpen={open} />
            </div>
            <div className="gc-needs-detail-pane min-w-0">
              {selected ? (
                <>
                  <DecisionDetail
                    key={selected.visit}
                    decisions={decisions}
                    refId={selected.ref}
                    arm={selected.arm}
                    onBack={() => setSelected(null)}
                    onNavigate={(ref) => open(ref)}
                    onAsk={ask}
                  />
                  {next ? (
                    <div className="gc-needs-up-next">
                      <span>Up next</span>
                      <Button variant="ghost" size="sm" className="min-w-0" onClick={() => open(next.ref)}>
                        <span className="line-clamp-2">
                          {next.ref} · {next.question}
                        </span>
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <EmptyState title="Choose a decision">See the question, consequences and evidence here.</EmptyState>
              )}
            </div>
          </div>
        ) : null}
        <DecisionNotices notices={feedback.notices} />
      </div>
    </DecisionFeedbackContext.Provider>
  );
}
