"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { Button, Card, ChipButton, EmptyState, IconButton, Menu, Pill, SectionHeader, Toast, useNow } from "@/components/ui";
import type { UndoOp } from "@/components/work/UndoBar";
import { AGEING_MS, RISK_LABEL, type Decision } from "@/lib/cw-decisions";
import { ageLabel, defaultLine, deferUntil, isRisky, recommendedChoice } from "@/lib/coordinator/needs";
import {
  DECISION_UNDO_MS,
  DECISIONS_KEY,
  useAnswerDecision,
  useDecisionFeedback,
  type DecisionNotice,
  type DecisionsResponse,
  type NeedsOpenOptions,
} from "./useCoordinatorDecisions";

export function DecisionNotices({ notices }: { notices: DecisionNotice[] }) {
  return (
    <div className="gc-needs-notices">
      {notices.map((n) => (
        <Toast
          key={n.id}
          message={n.text}
          action={{
            label: "Undo",
            onClick: () => {
              void n.undo();
            },
          }}
        />
      ))}
    </div>
  );
}
export function DecisionId({ refId }: { refId: string }) {
  return (
    <span role="img" aria-label={`Decision ${refId.replace("-", " ")}`}>
      <Pill tone="ai">{refId}</Pill>
    </span>
  );
}
export function DecisionMenu({
  decision,
  onAsk,
  onDefer,
  disabled,
  label = `More actions for ${decision.ref}`,
}: {
  decision: Decision;
  onAsk?: () => void;
  onDefer: (until: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="gc-needs-menu">
      {onAsk ? (
        <IconButton
          ref={trigger}
          label={label}
          icon={<span aria-hidden="true">⋯</span>}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        />
      ) : (
        <Button ref={trigger} size="sm" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Defer
        </Button>
      )}
      {open ? (
        <Menu
          label={label}
          items={[
            { label: "Defer 1 h", onSelect: () => onDefer(deferUntil("hour")) },
            { label: "Defer until tomorrow 9:00", onSelect: () => onDefer(deferUntil("tomorrow")) },
            ...(onAsk ? [{ label: "Ask about", onSelect: onAsk }] : []),
          ]}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

type Receipt = { decision: Decision; answer: string; undo: (() => Promise<void>) | null };
export function NeedsList({
  decisions,
  onOpen,
  onAnswered,
}: {
  decisions: Decision[];
  onOpen: (ref: string, options?: NeedsOpenOptions) => void;
  onAnswered?: (op: UndoOp) => void;
}) {
  const answer = useAnswerDecision();
  const client = useQueryClient();
  const { feedback, shared } = useDecisionFeedback();
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const [pending, setPending] = useState<string[]>([]);
  const inFlight = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [batch, setBatch] = useState<Decision[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  useEffect(() => {
    const active = timers.current;
    return () => active.forEach(clearTimeout);
  }, []);
  const now = useNow();
  const open = decisions.filter((d) => d.state === "open" && !receipts[d.ref]);
  const candidates = open.filter(
    (d) => !isRisky(d) && d.recommended && d.choices.includes(d.recommended) && !pending.includes(d.ref) && !feedback.deferring.includes(d.ref),
  );
  const visible = [
    ...decisions,
    ...Object.values(receipts)
      .map((r) => r.decision)
      .filter((r) => !decisions.some((d) => d.ref === r.ref)),
  ];
  const groups = [
    { title: "Ageing", rows: visible.filter((d) => now - Date.parse(d.createdAt) > AGEING_MS) },
    { title: "New", rows: visible.filter((d) => !(now - Date.parse(d.createdAt) > AGEING_MS)) },
  ];
  function clearReceipt(ref: string) {
    setReceipts((rows) => {
      const copy = { ...rows };
      delete copy[ref];
      return copy;
    });
  }
  function expireReceipt(ref: string) {
    const timer = setTimeout(() => {
      clearReceipt(ref);
      timers.current.delete(timer);
    }, DECISION_UNDO_MS);
    timers.current.add(timer);
  }
  async function handleAccept(decisionRef: string, choice: string) {
    const d = decisions.find((row) => row.ref === decisionRef && row.state === "open");
    if (!d || !d.choices.includes(choice) || feedback.deferring.includes(decisionRef)) return;
    if (inFlight.current.has(d.ref) || batchBusy) return;
    if (isRisky(d)) {
      onOpen(d.ref, { arm: choice });
      return;
    }
    inFlight.current.add(d.ref);
    setPending((refs) => [...refs, d.ref]);
    try {
      const result = await answer.mutateAsync({ ref: d.ref, answer: choice });
      const undo = result.op
        ? feedback.showUndo(`${d.ref} → ${choice}`, async () => {
            await feedback.undoOps([result.op!]);
            clearReceipt(d.ref);
          })
        : null;
      setReceipts((rows) => ({ ...rows, [d.ref]: { decision: d, answer: choice, undo } }));
      expireReceipt(d.ref);
      if (result.op) onAnswered?.(result.op);
      else feedback.toast(`Saved ${d.ref}`);
    } catch (error) {
      feedback.toast(error instanceof Error ? error.message : "Couldn't answer. Try again.", "danger");
    } finally {
      inFlight.current.delete(d.ref);
      setPending((refs) => refs.filter((ref) => ref !== d.ref));
    }
  }
  async function acceptBatch() {
    if (!batch || batchBusy || inFlight.current.size) return;
    setBatchBusy(true);
    const completed: { decision: Decision; op: UndoOp; answer: string }[] = [];
    try {
      for (const snapshot of batch) {
        const latest = client.getQueryData<DecisionsResponse>(DECISIONS_KEY)?.decisions ?? decisions;
        const d = latest.find((row) => row.ref === snapshot.ref && row.state === "open");
        // A refresh must never turn the owner's low-risk confirmation into a risky answer.
        if (!d || isRisky(d) || !d.recommended || d.recommended !== snapshot.recommended || !d.choices.includes(d.recommended)) continue;
        const result = await answer.mutateAsync({ ref: d.ref, answer: d.recommended });
        if (result.op) {
          completed.push({ decision: d, op: result.op, answer: d.recommended });
          onAnswered?.(result.op);
        } else feedback.toast(`Saved ${d.ref}`);
      }
    } catch (error) {
      feedback.toast(error instanceof Error ? error.message : "Couldn't finish. Remaining decisions are still open.", "danger");
    } finally {
      if (completed.length) {
        const undo = feedback.showUndo(`Answered ${completed.length}`, async () => {
          await feedback.undoOps(completed.map((r) => r.op));
          completed.forEach((r) => clearReceipt(r.decision.ref));
        });
        setReceipts((rows) => ({ ...rows, ...Object.fromEntries(completed.map((r) => [r.decision.ref, { decision: r.decision, answer: r.answer, undo }])) }));
        completed.forEach((r) => expireReceipt(r.decision.ref));
      }
      setBatch(null);
      setBatchBusy(false);
    }
  }
  return (
    <section className="gc-needs-list min-w-0" aria-label="Needs you decisions">
      <div className="gc-needs-header">
        <span>{open.length} open</span>
        {candidates.length >= 2 ? (
          <Button size="sm" disabled={batchBusy || pending.length > 0} onClick={() => setBatch([...candidates])}>
            Accept {candidates.length} low-risk
          </Button>
        ) : null}
      </div>
      {batch ? (
        <div role="group" aria-label="Confirm recommended answers">
          <Card className="gc-needs-confirm">
            <p>Accept {batch.length} recommended answers?</p>
            <ul>
              {batch.map((d) => (
                <li key={d.ref}>
                  {d.ref} · {d.question} → {d.recommended}
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
      {!visible.length ? (
        <EmptyState title="Nothing needs you">New decisions from agents show up here.</EmptyState>
      ) : (
        groups.map(({ title, rows }) =>
          rows.length ? (
            <section key={title} aria-label={title}>
              <SectionHeader label={title} count={rows.filter((d) => !receipts[d.ref]).length} />
              <div className="gc-needs-rows">
                {rows.map((d) => {
                  const receipt = receipts[d.ref];
                  const choice = recommendedChoice(d);
                  const compact = title === "New" && decisions.length > 12;
                  const disabled = pending.includes(d.ref) || batchBusy || feedback.deferring.includes(d.ref);
                  return receipt ? (
                    <div className="gc-needs-receipt" key={d.ref}>
                      <CheckIcon className="h-4 w-4" />
                      <span>{receipt.answer}</span>
                      {receipt.undo ? (
                        <Button
                          size="sm"
                          onClick={() => {
                            void receipt.undo?.();
                          }}
                        >
                          Undo
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <div className={`gc-needs-row${compact ? " gc-needs-row-compact" : ""}`} key={d.ref}>
                      <Button variant="ghost" className="gc-needs-row-body" onClick={() => onOpen(d.ref)} aria-label={`Open decision ${d.ref}: ${d.question}`}>
                        <span className="gc-needs-row-title">
                          {!compact ? <DecisionId refId={d.ref} /> : null}
                          <span className={compact ? "gc-needs-one-line" : "line-clamp-2"}>{d.question}</span>
                        </span>
                        {!compact ? (
                          <span className="gc-needs-meta">
                            {ageLabel(d.createdAt, now)} · {[d.areaTitle, d.itemTitle].filter(Boolean).join(" / ") || d.itemId}
                            {isRisky(d) ? (
                              <span className="gc-needs-risk">
                                <AlertIcon className="h-3 w-3" />
                                {d.risk.map((r) => RISK_LABEL[r]).join(" · ")}
                              </span>
                            ) : null}
                            {defaultLine(d, now) ? <span>{defaultLine(d, now)}</span> : null}
                          </span>
                        ) : null}
                      </Button>
                      <div className="gc-needs-row-actions">
                        {choice ? (
                          <ChipButton
                            disabled={disabled}
                            aria-label={`${d.ref}: ${choice}`}
                            onClick={() => {
                              // eslint-disable-next-line react-hooks/refs -- event-only handler: D-n is a data ref; the in-flight React ref is never read during render
                              void handleAccept(d.ref, choice);
                            }}
                          >
                            {choice}
                          </ChipButton>
                        ) : null}
                        <DecisionMenu
                          decision={d}
                          disabled={disabled}
                          onAsk={() => onOpen(d.ref, { ask: true })}
                          onDefer={(until) => feedback.stageDefer(d.ref, until)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null,
        )
      )}
      {!shared ? <DecisionNotices notices={feedback.notices} /> : null}
    </section>
  );
}
