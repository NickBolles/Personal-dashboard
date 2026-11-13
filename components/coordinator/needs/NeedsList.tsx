"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, SectionHeader, useNow } from "@/components/ui";
import type { UndoOp } from "@/components/work/UndoBar";
import { DecisionNotices, DecisionReceiptLine, DecisionRow } from "@/components/decisions/DecisionBlock";
import { isReceipt, withReceipts } from "@/components/decisions/useAnswerDecision";
import { AGEING_MS, type Decision } from "@/lib/cw-decisions";
import { isRiskyDecision, viewOfDecision, type DecisionView } from "@/lib/decision-view";
import { DECISIONS_KEY, useDecisionFlow, type DecisionsResponse, type NeedsOpenOptions } from "./useCoordinatorDecisions";

/**
 * The Chief of staff "Needs you" list: every open decision as the shared row (components/decisions), oldest
 * waits first. A low-risk row answers from its chips; a risky one opens the card. "Accept N low-risk" takes the
 * agents' recommendations in one confirmed step.
 */
export function NeedsList({
  decisions,
  onOpen,
  onAnswered,
  hasOther,
}: {
  decisions: Decision[];
  onOpen: (ref: string, options?: NeedsOpenOptions) => void;
  onAnswered?: (op: UndoOp) => void;
  hasOther?: boolean;
}) {
  const client = useQueryClient();
  const { flow, shared } = useDecisionFlow();
  const [batch, setBatch] = useState<DecisionView[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const now = useNow();
  const views = decisions.filter((d) => d.state === "open").map(viewOfDecision);
  const open = views.filter((v) => !flow.receipts[v.ref]);
  const candidates = open.filter((v) => !isRiskyDecision(v) && v.recommended && !flow.busy(v.ref));
  const rows = withReceipts(views, flow.receipts);
  const viewOf = (row: (typeof rows)[number]) => (isReceipt(row) ? row.view : row);
  const old = (v: DecisionView) => now - Date.parse(v.createdAt) > AGEING_MS;
  const groups = [
    { title: "Waiting over a day", rows: rows.filter((row) => old(viewOf(row))) },
    { title: "New", rows: rows.filter((row) => !old(viewOf(row))) },
  ];
  async function acceptBatch() {
    if (!batch || batchBusy || flow.pending.length) return;
    setBatchBusy(true);
    const done: { ref: string; op: UndoOp }[] = [];
    try {
      for (const snapshot of batch) {
        const latest = client.getQueryData<DecisionsResponse>(DECISIONS_KEY)?.decisions ?? decisions;
        const d = latest.find((row) => row.ref === snapshot.ref && row.state === "open");
        const view = d ? viewOfDecision(d) : null;
        // A refresh must never turn the owner's low-risk confirmation into a risky answer.
        if (!view || isRiskyDecision(view) || !view.recommended || view.recommended !== snapshot.recommended) continue;
        const result = await flow.answer(view, view.recommended, { index: views.findIndex((v) => v.ref === view.ref) });
        // A failed answer was already said in a toast; the remaining decisions stay open.
        if (!result) break;
        if (result.op) {
          done.push({ ref: view.ref, op: result.op });
          onAnswered?.(result.op);
        }
      }
    } finally {
      // Each answered row is its own receipt with its own Undo; a batch of several also undoes as one.
      if (done.length > 1)
        flow.showUndo(
          `${done.length} decisions answered`,
          async () => {
            await flow.undoOps(done.map((r) => r.op));
            done.forEach((r) => flow.dropReceipt(r.ref));
          },
          { undoLabel: "Undo all" },
        );
      setBatch(null);
      setBatchBusy(false);
    }
  }
  return (
    <section className="gc-needs-list min-w-0" aria-label="Needs you decisions">
      {/* An empty queue is said once, by the empty state below. */}
      <div className="gc-needs-header" hidden={!open.length}>
        <span>{open.length === 1 ? "1 open decision" : `${open.length} open decisions`}</span>
        {candidates.length >= 2 ? (
          <Button size="sm" disabled={batchBusy || flow.pending.length > 0} onClick={() => setBatch([...candidates])}>
            Accept {candidates.length} low-risk
          </Button>
        ) : null}
      </div>
      {batch ? (
        <div role="group" aria-label="Confirm recommended answers">
          <Card className="gc-needs-confirm">
            <p>Accept {batch.length} recommended answers?</p>
            <ul>
              {batch.map((v) => (
                <li key={v.ref}>
                  {v.ref} · {v.question} → {v.recommended}
                </li>
              ))}
            </ul>
            <div className="gc-needs-actions">
              <Button
                variant="primary"
                loading={batchBusy}
                onClick={() => {
                  void acceptBatch();
                }}
              >
                Confirm
              </Button>
              <Button disabled={batchBusy} onClick={() => setBatch(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
      {!rows.length ? (
        <EmptyState title={hasOther ? "No open decisions" : "Nothing needs you"}>New decisions from agents show up here.</EmptyState>
      ) : (
        groups.map(({ title, rows: groupRows }) =>
          groupRows.length ? (
            <section key={title} aria-label={title} data-land={title === "New" ? "new" : undefined}>
              <SectionHeader label={title} count={groupRows.filter((row) => !isReceipt(row)).length} />
              <div className="gc-needs-rows">
                {groupRows.map((row) =>
                  isReceipt(row) ? (
                    <DecisionReceiptLine
                      key={row.view.ref}
                      receipt={row}
                      onUndo={() => {
                        void flow.undo(row.view.ref);
                      }}
                    />
                  ) : (
                    <DecisionRow
                      key={row.ref}
                      view={row}
                      flow={flow}
                      now={now}
                      index={views.findIndex((v) => v.ref === row.ref)}
                      disabled={batchBusy}
                      onOpen={(ref) => onOpen(ref)}
                      onAsk={(ref) => onOpen(ref, { ask: true })}
                      onAnswered={(result) => {
                        if (result.op) onAnswered?.(result.op);
                      }}
                    />
                  ),
                )}
              </div>
            </section>
          ) : null,
        )
      )}
      {!shared ? <DecisionNotices notices={flow.notices} /> : null}
    </section>
  );
}
