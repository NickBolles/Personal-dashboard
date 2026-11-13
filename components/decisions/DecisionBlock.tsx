"use client";

/**
 * The one decision block. A decision (D-n) is drawn by these three pieces on every surface and by nothing else:
 *
 * - `DecisionRow`: the row in a list. Line one is the D-n and the question, line two the item, what it blocks and
 *   its age. A low-risk decision offers its choices as chips under the row (the agent's recommendation is marked;
 *   nothing is marked when there is none). A risky one shows its risk on line two and no chips: it opens the card.
 * - `DecisionCard`: the whole decision, drawn as the decision sheet wherever it appears (chat, top of an item,
 *   the decision page, the Chief of staff detail): a title bar ("Decision", with "1 of N" and next / previous when
 *   there are several), the D-n context line, the question, why it is asked now, then each choice with its effect.
 *   One tap answers. Only a risky choice takes a second step: it arms, and the in-place "Confirm: <choice>" sends it.
 * - `DecisionReceiptLine`: what either becomes once answered, one line per decision: the D-n, what was asked and
 *   what was answered ("D-52 · Budget ceiling for the desk · Up to $400"), with Undo for ten seconds.
 *
 * Answering goes through one flow (useAnswerDecision.ts). Free text never gets a box here: "Something else…"
 * hands the D-n to the Chief of staff composer (`onAsk`), or opens the Chief of staff on that decision.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronIcon } from "@/components/icons";
import { AnchoredMenu, Button, ButtonLink, ChipButton, MenuButton, RefPill, RowAction, ThingRow, Toast, cx, useAnchoredMenu, useNow } from "@/components/ui";
import { Markdown } from "@/components/markdown/Markdown";
import { ageLabel, decisionKeyAction, defaultLine, deferUntil, safeEvidenceHref } from "@/lib/coordinator/needs";
import { isAppPath } from "@/lib/decisions";
import {
  aboutItem,
  answerGate,
  isDangerous,
  isRiskyDecision,
  questionLines,
  receiptText,
  riskLine,
  rowChoices,
  shortQuestion,
  viewOfEntry,
  type DecisionView,
} from "@/lib/decision-view";
import { useDecisionFlow, useInboxDecisions, type AnswerResult, type DecisionFlow, type DecisionNotice, type DecisionReceipt } from "./useAnswerDecision";
import "./decisions.css";

export type AskAbout = (ref: string, question: string) => void;

/**
 * Where "Something else…" goes on a surface with no composer of its own: the Chief of staff, opened on this
 * decision (the `?coord=needs&d=D-n` deep link), keeping the page and its other parameters.
 */
export function openDecisionInCoordinator(ref: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("coord", "needs");
  url.searchParams.set("d", ref);
  url.searchParams.delete("r");
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

const speak = (ref: string) => `Decision ${ref.replace("-", " ")}`;

/** Ten-second lines that are not one decision's receipt: a staged defer, a confirmed batch. */
export function DecisionNotices({ notices, children }: { notices: DecisionNotice[]; children?: ReactNode }) {
  if (!notices.length && !children) return null;
  return (
    <div className="dcs-notices">
      {children}
      {notices.map((n) => (
        <Toast
          key={n.id}
          message={n.text}
          action={{
            label: n.undoLabel ?? "Undo",
            onClick: () => {
              void n.undo();
            },
          }}
        />
      ))}
    </div>
  );
}

/**
 * What a row or a card becomes once answered: the D-n, what was asked (short) and what was answered, on one line.
 * The question gives way first when the line is tight; the answer is what the owner needs to see to trust Undo.
 */
export function DecisionReceiptLine({
  receipt,
  onUndo,
  action,
  className,
}: {
  receipt: DecisionReceipt;
  onUndo?: () => void;
  /** A quiet follow-up that belongs to this answer (posting it to the item's conversation). */
  action?: ReactNode;
  className?: string;
}) {
  const { view, choice } = receipt;
  return (
    <div
      role="status"
      className={cx("dcs-receipt", className)}
      data-density="sleek"
      data-testid="decision-receipt"
      data-ref={view.ref}
      title={receiptText(view, choice)}
    >
      <ThingRow
        tight
        state="done"
        refId={view.ref}
        title={
          <span className="dcs-rc">
            <span className="sr-only">answered: </span>
            <span className="dcs-rc-q">{shortQuestion(view)}</span>
            <span className="dcs-rc-a"> · {choice}</span>
          </span>
        }
        actions={
          action || (receipt.undoable && onUndo) ? (
            <>
              {action}
              {receipt.undoable && onUndo ? (
                <Button size="sm" variant="ghost" className="dcs-undo" aria-label={`Undo ${view.ref}`} onClick={onUndo}>
                  Undo
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
    </div>
  );
}

function deferItems(ref: string, flow: DecisionFlow) {
  return [
    { label: "Defer 1 h", onSelect: () => flow.stageDefer(ref, deferUntil("hour")) },
    { label: "Defer until tomorrow 9:00", onSelect: () => flow.stageDefer(ref, deferUntil("tomorrow")) },
  ];
}

/** Line two of a row: what makes it risky, the item, what it blocks, how long it has waited, what happens by default. */
function RowMeta({ view, now, ask, about }: { view: DecisionView; now: number; ask: string | null; about: string | null }) {
  const risky = isRiskyDecision(view);
  const defaults = defaultLine(view, now);
  return (
    <span className="dcs-meta">
      {ask ? <span className="dcs-ask">{ask}</span> : null}
      {risky ? <span className="dcs-risk">{riskLine(view)}</span> : null}
      {risky ? <span>open to answer</span> : null}
      {about ? <span>{about}</span> : null}
      {view.blocks ? (
        <span>
          blocks <RefPill id={view.blocks} />
        </span>
      ) : null}
      <span>{ageLabel(view.createdAt, now)}</span>
      {defaults ? <span>{defaults}</span> : null}
    </span>
  );
}

/**
 * A decision in a list. The body opens the card (`onOpen`); the chips answer a low-risk decision in one tap; the
 * menu (the ⋯, a long press or a right-click) defers it or takes it to the composer.
 */
export function DecisionRow({
  view,
  flow,
  now,
  index = 0,
  onOpen,
  onAsk,
  onAnswered,
  disabled,
  className,
}: {
  view: DecisionView;
  flow: DecisionFlow;
  now: number;
  /** Position in its list, so the receipt takes the row's place. */
  index?: number;
  onOpen: (ref: string) => void;
  onAsk?: AskAbout;
  onAnswered?: (result: AnswerResult, choice: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const menu = useAnchoredMenu();
  const q = questionLines(view);
  const chips = rowChoices(view);
  const busy = disabled || flow.busy(view.ref);
  const label = `More actions for ${view.ref}`;
  async function tap(choice: string) {
    // The gate holds a risky answer back even if a chip were ever drawn for one: it opens the card instead.
    if (answerGate(view, choice) !== "send") return onOpen(view.ref);
    const result = await flow.answer(view, choice, { index });
    if (result) onAnswered?.(result, choice);
  }
  return (
    <div className={cx("dcs-item", className)} data-density="sleek" data-testid="decision-row" data-ref={view.ref} {...menu.surfaceProps}>
      <ThingRow
        className="dcs-row"
        state="needs"
        refId={view.ref}
        title={<span className={cx("dcs-wrap", chips.length > 0 && "dcs-wrap-all")}>{q.title}</span>}
        sub={<RowMeta view={view} now={now} ask={q.titled ? q.rest : null} about={aboutItem(view, q.titled)} />}
        onOpen={() => onOpen(view.ref)}
        hitProps={{ "aria-label": `Open decision ${view.ref}: ${view.question}`, "data-decision-ref": view.ref }}
        actions={<MenuButton menu={menu} label={label} />}
      />
      {chips.length ? (
        <div className="dcs-chips" role="group" aria-label={`Answer ${view.ref}`}>
          {chips.map((choice) => {
            const recommended = view.recommended === choice;
            return (
              <ChipButton
                key={choice}
                className={cx("dcs-chip", recommended && "dcs-chip-rec")}
                disabled={busy}
                aria-label={`${view.ref}: ${choice}${recommended ? " (recommended)" : ""}`}
                title={recommended ? "Recommended" : undefined}
                onClick={() => {
                  void tap(choice);
                }}
              >
                {choice}
              </ChipButton>
            );
          })}
        </div>
      ) : null}
      <AnchoredMenu
        menu={menu}
        label={label}
        items={[
          ...deferItems(view.ref, flow).map((item) => ({ ...item, disabled: busy })),
          {
            label: "Something else…",
            onSelect: () => (onAsk ? onAsk(view.ref, view.question) : openDecisionInCoordinator(view.ref)),
          },
        ]}
      />
    </div>
  );
}

export type DecisionCardState = ReturnType<typeof useDecisionCard>;

/**
 * The answer state of one open card: which risky choice is armed, and the only two ways an answer leaves it.
 * `pick` sends a low-risk choice and ARMS a risky one; `confirm` is the second tap that sends an armed choice.
 */
export function useDecisionCard(
  view: DecisionView | null,
  flow: DecisionFlow,
  options: { arm?: string; index?: number; onAnswered?: (result: AnswerResult, choice: string) => void } = {},
) {
  const [armed, setArmed] = useState<string | null>(() =>
    view && isRiskyDecision(view) && options.arm && view.choices.includes(options.arm) ? options.arm : null,
  );
  const busy = view ? flow.busy(view.ref) : false;
  const answered = view ? !!flow.receipts[view.ref] : false;
  async function send(choice: string, confirmed: boolean) {
    if (!view) return;
    const result = await flow.answer(view, choice, { confirmed, index: options.index });
    if (!result) return;
    setArmed(null);
    options.onAnswered?.(result, choice);
  }
  function pick(choice: string) {
    if (!view || busy || answered || !view.choices.includes(choice)) return;
    if (answerGate(view, choice) === "confirm") setArmed(choice);
    else void send(choice, false);
  }
  function confirm() {
    if (!view || busy || answered || !armed || !view.choices.includes(armed)) return;
    void send(armed, true);
  }
  const cancel = () => setArmed(null);
  return { armed: view && armed && view.choices.includes(armed) ? armed : null, busy, answered, pick, confirm, cancel };
}

/**
 * Keys an open card answers to: 1-4 pick a choice (a risky one only arms), Enter confirms an armed choice, Esc
 * cancels it. Returns true when the key was used. Enter on a focused control does what that control does.
 */
export function handleCardKey(e: KeyboardEvent<HTMLElement>, view: DecisionView, card: DecisionCardState): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return false;
  const target = e.target as HTMLElement;
  const typing = !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
  if (e.key === "Enter" && target !== e.currentTarget && target.closest("button, a")) return false;
  const action = decisionKeyAction(e.key, { typing, armed: !!card.armed && !card.answered });
  if (action === "confirm") {
    e.preventDefault();
    card.confirm();
    return true;
  }
  if (action === "back" && card.armed) {
    e.preventDefault();
    card.cancel();
    return true;
  }
  if (action?.startsWith("pick-")) {
    const choice = view.choices[Number(action.slice(-1)) - 1];
    if (!choice) return false;
    e.preventDefault();
    card.pick(choice);
    return true;
  }
  return false;
}

function Evidence({ view }: { view: DecisionView }) {
  if (!view.pack.evidence?.length) return null;
  return (
    <section aria-label="Evidence" className="dcs-evidence">
      <h4>Evidence</h4>
      {view.pack.evidence.map((evidence, i) => {
        const href = safeEvidenceHref(evidence.url);
        const external = !!href && /^https:/i.test(href);
        return (
          <div className="dcs-evidence-row" key={`${evidence.label}-${i}`}>
            {href ? (
              <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
                {evidence.label}
                {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
              </a>
            ) : (
              <span>{evidence.label}</span>
            )}
            {evidence.ref ? <span className="dcs-evidence-ref">{evidence.ref}</span> : null}
            {evidence.text ? (
              ["diff", "code", "log"].includes(evidence.kind) ? (
                <pre tabIndex={0} aria-label={evidence.label}>
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
  );
}

export type DecisionPager = { index: number; total: number; onPrev?: () => void; onNext?: () => void };

/**
 * The card, drawn from a card state the caller holds (the Chief of staff detail drives it with its own keys).
 * Most surfaces want `DecisionCard`, which holds the state itself.
 */
export function DecisionCardView({
  view,
  card,
  flow,
  now,
  onAsk,
  onClose,
  closeLabel,
  backHref,
  onRef,
  pager,
  nextRef,
  barAs: BarTitle = "span",
  heading: Heading = "h3",
  className,
}: {
  view: DecisionView;
  card: DecisionCardState;
  flow: DecisionFlow;
  now: number;
  onAsk?: AskAbout;
  /** The back arrow in the title bar: fold the card back into its row, or return to the list. */
  onClose?: () => void;
  closeLabel?: string;
  /** A back arrow that is a link (the decision page goes back to "Needs you"). */
  backHref?: string;
  /** Jump to the piece of work this decision blocks. */
  onRef?: (ref: string) => void;
  /** "1 of N" with previous / next, drawn when there is more than one decision to page through. */
  pager?: DecisionPager;
  /** Where the surface moves once this one is answered: said in the footer, so the jump is expected. */
  nextRef?: string | null;
  /** The title bar's "Decision" is the page's heading on the decision page; a label elsewhere. */
  barAs?: "h1" | "h2" | "span";
  heading?: "h2" | "h3";
  className?: string;
}) {
  const menu = useAnchoredMenu();
  const q = questionLines(view);
  const risky = isRiskyDecision(view);
  const about = aboutItem(view, q.titled);
  const defaults = defaultLine(view, now);
  const facts = [
    ...(view.raisedBy ? [{ label: "Raised by", value: view.raisedBy }] : []),
    ...(defaults ? [{ label: "Default", value: defaults }] : []),
    ...(view.pack.facts ?? []),
    ...(view.pack.unblocks?.length ? [{ label: "Unblocks", value: view.pack.unblocks.join(" · ") }] : []),
  ];
  const ask = () => (onAsk ? onAsk(view.ref, view.question) : openDecisionInCoordinator(view.ref));
  return (
    <section
      className={cx("dcs-card", className)}
      data-density="sleek"
      data-testid="decision-card"
      data-ref={view.ref}
      data-risky={risky || undefined}
      aria-label={speak(view.ref)}
    >
      <header className="dcs-bar">
        {backHref ? (
          <ButtonLink
            href={backHref}
            variant="ghost"
            size="sm"
            className="k-btn-icon k-thing-act dcs-bar-back"
            aria-label={closeLabel ?? "Back"}
            icon={<ChevronIcon className="h-4 w-4 rotate-180" />}
          >
            <span className="sr-only">{closeLabel ?? "Back"}</span>
          </ButtonLink>
        ) : onClose ? (
          <RowAction
            className="dcs-bar-back"
            label={closeLabel ?? `Close ${view.ref}`}
            icon={<ChevronIcon className="h-4 w-4 rotate-180" />}
            onClick={onClose}
          />
        ) : null}
        <BarTitle className="dcs-bar-title">Decision</BarTitle>
        {pager && pager.total > 1 ? (
          <span className="dcs-pager">
            <span className="dcs-position" aria-label={`Decision ${pager.index + 1} of ${pager.total}`}>
              {pager.index + 1} of {pager.total}
            </span>
            <RowAction label="Previous decision" disabled={!pager.onPrev} onClick={pager.onPrev} icon={<ChevronIcon className="h-4 w-4 rotate-180" />} />
            <RowAction label="Next decision" disabled={!pager.onNext} onClick={pager.onNext} icon={<ChevronIcon className="h-4 w-4" />} />
          </span>
        ) : null}
      </header>
      <div className="dcs-ctx">
        <RefPill id={view.ref} />
        {about || view.blocks ? (
          <span className="dcs-ctx-text">
            {[about, view.blocks ? "blocks" : null].filter(Boolean).join(" · ")}
            {view.blocks ? (
              <>
                {" "}
                <RefPill id={view.blocks} onClick={onRef ? () => onRef(view.blocks!) : undefined} />
              </>
            ) : null}
          </span>
        ) : null}
        <span className="dcs-age">{ageLabel(view.createdAt, now)}</span>
      </div>
      <Heading className="dcs-q">{q.title}</Heading>
      {q.rest ? <p className="dcs-body">{q.rest}</p> : null}
      {view.pack.why ? <p className="dcs-why">{view.pack.why}</p> : null}
      {view.detail ? (
        <div className="dcs-detail" data-testid="decision-detail">
          <Markdown text={view.detail} />
        </div>
      ) : null}
      {view.action && isAppPath(view.action.href) ? (
        <ButtonLink href={view.action.href} size="sm" variant="primary" className="dcs-action" data-testid="decision-action">
          {view.action.label}
        </ButtonLink>
      ) : null}
      {facts.length ? (
        <dl className="dcs-facts">
          {facts.map((fact, i) => (
            <div key={`${fact.label}-${i}`}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Evidence view={view} />
      {risky && view.choices.length ? (
        <p className="dcs-flag">
          <span className="dcs-risk">{riskLine(view)}</span>
          <span>Your answer takes a second tap to confirm.</span>
        </p>
      ) : null}
      {view.choices.length ? (
        <div role="group" aria-label={`Answers for ${view.ref}`} className="dcs-options">
          {view.choices.map((choice) => {
            const effect = view.pack.options?.find((option) => option.choice === choice)?.effect;
            const armed = card.armed === choice;
            return (
              <div className="dcs-option-slot" key={choice}>
                <Button
                  variant="secondary"
                  className="dcs-option"
                  data-density-skip
                  data-armed={armed || undefined}
                  data-recommended={view.recommended === choice || undefined}
                  aria-pressed={armed}
                  disabled={card.busy || card.answered}
                  onClick={() => card.pick(choice)}
                >
                  <span className="dcs-option-title">
                    <span>{choice}</span>
                    {armed ? <span className="dcs-tag dcs-tag-risk">{riskLine(view)}</span> : null}
                    {!armed && view.recommended === choice ? <span className="dcs-tag">Recommended</span> : null}
                  </span>
                  {effect ? <span className="dcs-option-effect">{effect}</span> : null}
                </Button>
                {armed ? (
                  <div role="group" aria-label="Confirm answer" className="dcs-confirm">
                    <Button
                      variant={isDangerous(view) ? "danger" : "primary"}
                      loading={flow.pending.includes(view.ref)}
                      disabled={card.busy}
                      onClick={card.confirm}
                    >
                      Confirm: {choice}
                    </Button>
                    <Button variant="ghost" disabled={flow.pending.includes(view.ref)} onClick={card.cancel}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="dcs-why">This one has no listed answers.</p>
      )}
      <div className="dcs-foot">
        <Button
          size="sm"
          variant="ghost"
          className="dcs-link"
          aria-label={`${view.choices.length ? "Something else" : "Answer in your own words"}: ${view.ref}`}
          onClick={ask}
        >
          {view.choices.length ? "Something else…" : "Answer in your own words…"}
        </Button>
        <MenuButton menu={menu} label={`Defer ${view.ref}`} />
        {nextRef ? <span className="dcs-next">Moves to {nextRef} after you answer</span> : null}
      </div>
      <AnchoredMenu
        menu={menu}
        label={`Defer ${view.ref}`}
        items={deferItems(view.ref, flow).map((item) => ({ ...item, disabled: card.busy || card.answered }))}
      />
    </section>
  );
}

/** The card with its own answer state and keys. */
export function DecisionCard({
  view,
  flow,
  now,
  arm,
  index,
  onAnswered,
  autoFocus,
  ...rest
}: {
  view: DecisionView;
  flow: DecisionFlow;
  now: number;
  /** Open with this risky choice already armed (never sent): a deep link that names a choice. */
  arm?: string;
  index?: number;
  onAnswered?: (result: AnswerResult, choice: string) => void;
  /** Take focus on mount: the card just opened from its row. */
  autoFocus?: boolean;
} & Pick<
  Parameters<typeof DecisionCardView>[0],
  "onAsk" | "onClose" | "closeLabel" | "backHref" | "onRef" | "pager" | "nextRef" | "barAs" | "heading" | "className"
>) {
  const card = useDecisionCard(view, flow, { arm, index, onAnswered });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) root.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <div
      ref={root}
      className="dcs-card-host"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (handleCardKey(e, view, card)) return;
        if (e.key === "Escape" && rest.onClose && !e.defaultPrevented) {
          e.preventDefault();
          rest.onClose();
        }
      }}
    >
      <DecisionCardView view={view} card={card} flow={flow} now={now} {...rest} />
    </div>
  );
}

/**
 * One decision in a list that opens in place: a row, the card while it is open, the receipt once answered.
 * The card replaces the row (a decision is drawn once), and folds back with its back arrow or Esc.
 */
export function DecisionThing({
  view,
  receipt,
  flow,
  now,
  index,
  open,
  onToggle,
  onAsk,
  onAnswered,
  pager,
  receiptAction,
}: {
  view: DecisionView;
  receipt?: DecisionReceipt;
  flow: DecisionFlow;
  now: number;
  index: number;
  open: boolean;
  onToggle: (ref: string, open: boolean) => void;
  onAsk?: AskAbout;
  onAnswered?: (result: AnswerResult, choice: string) => void;
  /** The open card pages through the list's other decisions. */
  pager?: DecisionPager;
  receiptAction?: ReactNode;
}) {
  if (receipt)
    return (
      <DecisionReceiptLine
        receipt={receipt}
        action={receiptAction}
        onUndo={() => {
          void flow.undo(view.ref);
        }}
      />
    );
  if (open)
    return (
      <div className="dcs-item dcs-item-open" data-testid="decision-row" data-ref={view.ref}>
        <DecisionCard
          key={view.ref}
          view={view}
          flow={flow}
          now={now}
          index={index}
          onAsk={onAsk}
          onAnswered={onAnswered}
          onClose={() => onToggle(view.ref, false)}
          closeLabel={`Back to the list from ${view.ref}`}
          pager={pager}
          autoFocus
        />
      </div>
    );
  return <DecisionRow view={view} flow={flow} now={now} index={index} onOpen={(ref) => onToggle(ref, true)} onAsk={onAsk} onAnswered={onAnswered} />;
}

/**
 * The open decisions of one item, at the top of its page: one card, paged ("1 of N") when the item has several,
 * and one receipt line per decision answered here. Draws nothing while the item has none.
 */
export function ItemDecisions({ itemId, onAsk, heading, className }: { itemId: string; onAsk?: AskAbout; heading?: "h2" | "h3"; className?: string }) {
  const inbox = useInboxDecisions();
  const { flow, shared } = useDecisionFlow();
  const now = useNow();
  const [at, setAt] = useState(0);
  const views = (inbox.data?.entries ?? [])
    .filter((e) => e.itemId === itemId)
    .map(viewOfEntry)
    .filter((v): v is DecisionView => !!v && !flow.receipts[v.ref]);
  const receipts = Object.values(flow.receipts).filter((r) => r.view.itemId === itemId);
  if (!views.length && !receipts.length) return null;
  const index = Math.min(at, views.length - 1);
  const view = views[index];
  return (
    <div className={cx("dcs-stack", className)} data-density="sleek" data-testid="item-decisions">
      {receipts.map((receipt) => (
        <DecisionReceiptLine
          key={receipt.view.ref}
          receipt={receipt}
          onUndo={() => {
            void flow.undo(receipt.view.ref);
          }}
        />
      ))}
      {view ? (
        <DecisionCard
          key={view.ref}
          view={view}
          flow={flow}
          now={now}
          index={index}
          onAsk={onAsk}
          heading={heading}
          nextRef={views[index + 1]?.ref ?? views[index - 1]?.ref ?? null}
          pager={{
            index,
            total: views.length,
            onPrev: index > 0 ? () => setAt(index - 1) : undefined,
            onNext: index < views.length - 1 ? () => setAt(index + 1) : undefined,
          }}
        />
      ) : null}
      {!shared ? <DecisionNotices notices={flow.notices} /> : null}
    </div>
  );
}
