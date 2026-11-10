"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertIcon, ChevronIcon } from "@/components/icons";
import { Button, ButtonLink, Card, IconButton, Pill, useNow } from "@/components/ui";
import { Markdown } from "@/components/markdown/Markdown";
import { RISK_LABEL, type Decision } from "@/lib/cw-decisions";
import { ageLabel, decisionKeyAction, defaultLine, deferUntil, isRisky, nextAfterAnswer, pagerState, safeEvidenceHref } from "@/lib/coordinator/needs";
import { plainStatusWords, sameLabel, splitLead } from "@/lib/chat/display";
import { DecisionId, DecisionMenu, DecisionNotices } from "./NeedsList";
import { useAnswerDecision, useDecisionFeedback } from "./useCoordinatorDecisions";

type Props = { decisions: Decision[]; refId: string; onBack: () => void; onNavigate: (ref: string) => void; onAsk: (ref: string) => void; arm?: string };
export function DecisionDetail(props: Props) {
  // Navigation resets the armed choice; a previous decision's confirmation can never leak.
  return <Detail key={props.refId} {...props} />;
}
function Detail({ decisions, refId, onBack, onNavigate, onAsk, arm }: Props) {
  const current = decisions.find((d) => d.ref === refId && d.state === "open");
  const [armed, setArmed] = useState<string | null>(() => (current && isRisky(current) && arm && current.choices.includes(arm) ? arm : null));
  const [focused, setFocused] = useState(0);
  const [submitted, setSubmitted] = useState<{ decision: Decision; answer: string; list: Decision[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const answer = useAnswerDecision();
  const { feedback, shared } = useDecisionFeedback();
  const root = useRef<HTMLDivElement>(null);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const undo = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    mounted.current = true;
    root.current?.focus();
    return () => {
      mounted.current = false;
      if (advance.current) clearTimeout(advance.current);
    };
  }, []);
  const d = current ?? submitted?.decision;
  const pager = pagerState(submitted?.list ?? decisions, refId);
  const now = useNow();
  const cancelAdvance = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
  };
  function go(ref: string | null) {
    cancelAdvance();
    if (ref) onNavigate(ref);
  }
  function back() {
    cancelAdvance();
    onBack();
  }
  async function submit(choice: string) {
    if (!current || busy.current || saved || !current.choices.includes(choice) || feedback.deferring.includes(refId)) return;
    busy.current = true;
    const snapshot = [...decisions];
    setSubmitted({ decision: current, answer: choice, list: snapshot });
    try {
      const result = await answer.mutateAsync({ ref: refId, answer: choice });
      const returnToDecision = async () => {
        cancelAdvance();
        if (result.op) await feedback.undoOps([result.op]);
        if (mounted.current) {
          setSubmitted(null);
          setSaved(false);
          setArmed(null);
          undo.current = null;
        }
        onNavigate(refId);
      };
      if (result.op) undo.current = feedback.showUndo(`${refId} → ${choice}`, returnToDecision);
      else feedback.toast(`Saved ${refId}`);
      if (mounted.current) {
        setArmed(null);
        setSaved(true);
        advance.current = setTimeout(() => {
          const next = nextAfterAnswer(snapshot, refId);
          if (next) onNavigate(next);
          else onBack();
        }, 600);
      }
    } catch (error) {
      if (mounted.current) setSubmitted(null);
      feedback.toast(error instanceof Error ? error.message : "Couldn't answer. Try again.", "danger");
    } finally {
      busy.current = false;
    }
  }
  function pick(choice: string) {
    if (!current || busy.current || saved || feedback.deferring.includes(refId)) return;
    if (isRisky(current)) setArmed(choice);
    else void submit(choice);
  }
  function keyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const target = e.target as HTMLElement;
    const typing = !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
    if (!typing && target.getAttribute("role") === "radio" && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key) && d?.choices.length) {
      e.preventDefault();
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
      const index = (focused + step + d.choices.length) % d.choices.length;
      setFocused(index);
      root.current?.querySelectorAll<HTMLButtonElement>("[role='radio']")[index]?.focus();
      return;
    }
    // Enter on a focused control (Cancel, Defer, a link) does what that control does, never Confirm.
    if (e.key === "Enter" && target !== root.current && target.closest("button:not([role='radio']), a")) return;
    const action = decisionKeyAction(e.key, { typing, armed: !!armed && !!current && !saved, canUndo: !!undo.current && saved });
    if (!action) return;
    e.preventDefault();
    if (action === "next") go(pager.next);
    else if (action === "prev") go(pager.prev);
    else if (action === "back") back();
    else if (action === "ask") {
      cancelAdvance();
      onAsk(refId);
    } else if (action === "defer" && current && !saved && !busy.current) feedback.stageDefer(refId, deferUntil("hour"));
    else if (action === "confirm" && armed) void submit(armed);
    else if (action === "undo") {
      cancelAdvance();
      void undo.current?.();
    } else if (action.startsWith("pick-") && d) {
      const choice = d.choices[Number(action.slice(-1)) - 1];
      if (choice) pick(choice);
    }
  }
  if (!d)
    return (
      <div className="gc-needs-detail min-w-0" ref={root} tabIndex={-1} onKeyDown={keyDown}>
        <Button size="sm" onClick={back} aria-label="Back to Needs you">
          Back
        </Button>
        <p>{refId} was already answered</p>
        {!shared ? <DecisionNotices notices={feedback.notices} /> : null}
      </div>
    );
  const risky = isRisky(d);
  const pending = answer.isPending || saved || feedback.deferring.includes(refId);
  const defaults = defaultLine(d, now);
  // An agent that puts a paragraph in the one-line question gets a short heading and the rest as body text.
  const split = splitLead(plainStatusWords(d.question));
  // No clean first sentence to lift: head the page with the item it is about and show the whole text once, below.
  const titled = !split.whole && !!d.itemTitle && !sameLabel(d.itemTitle, d.question);
  const asked = titled ? { lead: d.itemTitle!, rest: split.rest } : split;
  const where = [d.areaTitle, d.itemTitle].filter(Boolean).join(" / ") || d.itemId;
  const facts = [
    ...(where ? [{ label: "About", value: where }] : []),
    { label: "Raised by", value: d.raisedBy.replace(/^agent:/, "@") },
    ...(defaults ? [{ label: "Default", value: defaults }] : []),
    ...(d.pack.facts ?? []),
    ...(d.pack.unblocks?.length ? [{ label: "Unblocks", value: d.pack.unblocks.join(" · ") }] : []),
  ];
  return (
    <div className="gc-needs-detail min-w-0" ref={root} tabIndex={-1} onKeyDown={keyDown} aria-label={`Decision ${refId.replace("-", " ")}`}>
      <nav className="gc-needs-nav" aria-label="Decision navigation">
        <Button variant="ghost" size="sm" icon={<ChevronIcon className="h-4 w-4 rotate-180" />} aria-label="Back to Needs you" onClick={back}>
          Back
        </Button>
        <span className="gc-needs-meta">
          <DecisionId refId={refId} />
          <span>{ageLabel(d.createdAt, now)}</span>
        </span>
        <div className="gc-needs-pager">
          <span aria-label={`Decision ${Math.max(1, pager.index + 1)} of ${pager.total}`}>
            {Math.max(1, pager.index + 1)} / {pager.total}
          </span>
          <IconButton label="Previous decision" disabled={!pager.prev} onClick={() => go(pager.prev)} icon={<ChevronIcon className="h-4 w-4 rotate-180" />} />
          <IconButton label="Next decision" disabled={!pager.next} onClick={() => go(pager.next)} icon={<ChevronIcon className="h-4 w-4" />} />
        </div>
      </nav>
      <h3 className="gc-needs-question">{asked.lead}</h3>
      {asked.rest ? <p className="gc-needs-body">{asked.rest}</p> : null}
      {d.pack.why ? <p className="gc-needs-why">{d.pack.why}</p> : null}
      {d.detail ? (
        <div className="gc-needs-detail-text min-w-0">
          <Markdown text={d.detail} />
        </div>
      ) : null}
      {d.action && d.action.href.startsWith("/") && !d.action.href.startsWith("//") ? (
        <ButtonLink href={d.action.href} size="sm" variant="primary">
          {d.action.label}
        </ButtonLink>
      ) : null}
      {!d.choices.length ? (
        <p className="gc-needs-why">
          No one-tap answers here.{" "}
          <ButtonLink href={`/areas?item=${encodeURIComponent(d.itemId)}`} size="sm">
            Answer on the item
          </ButtonLink>
        </p>
      ) : null}
      <dl className="gc-needs-facts">
        {facts.map((fact, i) => (
          <div key={`${fact.label}-${i}`}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {d.pack.evidence?.length ? (
        <section aria-label="Evidence" className="gc-needs-evidence min-w-0">
          <h4>Evidence</h4>
          {d.pack.evidence.map((evidence, i) => {
            const href = safeEvidenceHref(evidence.url);
            const external = !!href && /^https:/i.test(href);
            return (
              <div className="gc-needs-evidence-row min-w-0" key={`${evidence.label}-${i}`}>
                {href ? (
                  <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
                    {evidence.label}
                    {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
                  </a>
                ) : (
                  <span>{evidence.label}</span>
                )}
                {evidence.ref ? <span className="gc-needs-meta">{evidence.ref}</span> : null}
                {evidence.text ? (
                  ["diff", "code", "log"].includes(evidence.kind) ? (
                    <pre className="overflow-x-auto" tabIndex={0} aria-label={evidence.label}>
                      {evidence.text}
                    </pre>
                  ) : (
                    <p>{evidence.text}</p>
                  )
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}
      {risky && d.choices.length ? (
        <p className="gc-needs-flag">
          <AlertIcon className="h-4 w-4" />
          {d.risk.map((flag) => RISK_LABEL[flag]).join(" · ")}
          <span>Your answer needs a second tap to confirm.</span>
        </p>
      ) : null}
      <div role="radiogroup" aria-label={`Answers for ${refId}`} className="gc-needs-options">
        {d.choices.map((choice, index) => {
          const effect = d.pack.options?.find((option) => option.choice === choice)?.effect;
          return (
            <Button
              key={choice}
              variant="secondary"
              role="radio"
              aria-checked={armed === choice || (saved && submitted?.answer === choice)}
              tabIndex={focused === index ? 0 : -1}
              disabled={pending}
              className="gc-needs-option"
              onFocus={() => setFocused(index)}
              onClick={() => pick(choice)}
            >
              <span className="gc-needs-option-title">
                <span>{choice}</span>
                {d.recommended === choice ? <Pill tone="ai">Recommended</Pill> : null}
              </span>
              {effect ? <span className="gc-needs-meta">{effect}</span> : null}
            </Button>
          );
        })}
      </div>
      {armed && risky && current && !saved && current.choices.includes(armed) ? (
        <div role="group" aria-label="Confirm answer">
          <Card className="gc-needs-confirm">
            <p>Confirm {armed}?</p>
            <p className="gc-needs-risk">
              <AlertIcon className="h-4 w-4" />
              {d.risk.map((flag) => RISK_LABEL[flag]).join(" · ")}
            </p>
            <div className="gc-needs-actions">
              <Button
                variant={d.risk.some((flag) => ["destructive", "credential", "money"].includes(flag)) ? "danger" : "primary"}
                loading={answer.isPending}
                disabled={saved || feedback.deferring.includes(refId)}
                onClick={() => {
                  void submit(armed);
                }}
              >
                Confirm {armed}
              </Button>
              <Button disabled={answer.isPending} onClick={() => setArmed(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="gc-needs-saved">
          Saved · {submitted?.answer}
        </p>
      ) : null}
      <div className="gc-needs-actions">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Ask about ${refId}`}
          onClick={() => {
            cancelAdvance();
            onAsk(refId);
          }}
        >
          Ask about this
        </Button>
        <DecisionMenu
          decision={d}
          disabled={pending}
          onDefer={(until) => {
            setArmed(null);
            feedback.stageDefer(refId, until);
          }}
        />
      </div>
      {!shared ? <DecisionNotices notices={feedback.notices} /> : null}
    </div>
  );
}
