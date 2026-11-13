/**
 * One decision (D-n), one view: what every surface needs to draw it and the rules for answering it.
 * Pure and client-safe. The Chief of staff queue reads `Decision` rows and the "Needs you" page reads
 * `DecisionEntry` projections of the same rows; both become a `DecisionView`, so the row, the card and the
 * receipt (components/decisions/DecisionBlock.tsx) never care where the record came from.
 *
 * The safety rule lives here, once: a risk-flagged decision is never answered by a single tap. `answerGate`
 * is what every surface asks before it sends; the answer hook asks it again before it posts.
 */
import { RISK_LABEL, type Decision, type DecisionPack, type RiskFlag } from "./cw-decisions";
import type { DecisionAction, DecisionEntry } from "./decisions";
import { RUN_REF } from "./cw-runs";
import { plainStatusWords, sameLabel, splitLead } from "./chat/display";

export type DecisionView = {
  /** "D-n": the handle the owner and the agents use, and the id the answer goes to. */
  ref: string;
  itemId: string;
  itemTitle?: string;
  areaTitle?: string;
  question: string;
  choices: string[];
  /** The agent's recommendation, only when it is one of the choices. Never a guess. */
  recommended: string | null;
  risk: RiskFlag[];
  pack: DecisionPack;
  detail?: string;
  action?: DecisionAction;
  defaultChoice: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** The piece of work paused on this answer ("blocks R-n"), when the record names one. */
  blocks: string | null;
  /** "@devchief" when an agent raised it. */
  raisedBy?: string;
};

const validRecommendation = (recommended: string | null | undefined, choices: readonly string[]) =>
  recommended && choices.includes(recommended) ? recommended : null;

/** The run this decision holds up: the raising run's own R-n, else the first R-n the pack says it unblocks. */
function blockedRun(runRef: string | null | undefined, pack: DecisionPack): string | null {
  if (runRef && RUN_REF.test(runRef)) return runRef;
  return pack.unblocks?.find((u) => RUN_REF.test(u.trim()))?.trim() ?? null;
}

const raiser = (raisedBy: string | undefined) => (raisedBy?.startsWith("agent:") ? `@${raisedBy.slice(6)}` : undefined);

export function viewOfDecision(d: Decision): DecisionView {
  const by = raiser(d.raisedBy);
  return {
    ref: d.ref,
    itemId: d.itemId,
    itemTitle: d.itemTitle,
    areaTitle: d.areaTitle,
    question: d.question,
    choices: d.choices,
    recommended: validRecommendation(d.recommended, d.choices),
    risk: d.risk,
    pack: d.pack,
    ...(d.detail ? { detail: d.detail } : {}),
    ...(d.action ? { action: d.action } : {}),
    defaultChoice: d.defaultChoice,
    expiresAt: d.expiresAt,
    createdAt: d.createdAt,
    blocks: blockedRun(d.runRef, d.pack),
    ...(by ? { raisedBy: by } : {}),
  };
}

/** An inbox entry that is a decision (kind "item" with its D-n). Approvals, proposals and stalled runs are not: null. */
export function viewOfEntry(e: DecisionEntry): DecisionView | null {
  if (e.kind !== "item" || !e.ref || !e.itemId) return null;
  const pack = e.pack ?? {};
  return {
    ref: e.ref,
    itemId: e.itemId,
    itemTitle: e.title,
    areaTitle: e.areaTitle,
    question: e.question,
    choices: e.choices,
    recommended: validRecommendation(e.recommended, e.choices),
    risk: e.risk ?? [],
    pack,
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.action ? { action: e.action } : {}),
    defaultChoice: e.defaultChoice ?? null,
    expiresAt: e.expiresAt ?? null,
    createdAt: e.at,
    blocks: blockedRun(e.runRef, pack),
    ...(e.askedBy ? { raisedBy: `@${e.askedBy}` } : {}),
  };
}

export const isRiskyDecision = (d: Pick<DecisionView, "risk">) => d.risk.length > 0;

/** "Money · Destructive": what makes the answer one to confirm. Empty for a low-risk decision. */
export const riskLine = (d: Pick<DecisionView, "risk">) => d.risk.map((flag) => RISK_LABEL[flag]).join(" · ");

/** Answers that move money, destroy something or hand over a credential confirm in the danger colour. */
export const isDangerous = (d: Pick<DecisionView, "risk">) => d.risk.some((flag) => flag === "destructive" || flag === "credential" || flag === "money");

export type QuestionLines = {
  /** Line one of the row, heading of the card. */
  title: string;
  /** What did not fit in the title: body text under the card's heading. */
  rest: string;
  /** The title is the item's name because the question has no short first sentence. */
  titled: boolean;
  /** The whole question is on the row, so answering from the row is not answering blind. */
  readable: boolean;
};

/**
 * An agent that writes a paragraph into the one-line question gets a short heading and the rest as body text;
 * a paragraph with no clean first sentence is headed by the item it is about. Nothing is dropped.
 */
export function questionLines(d: Pick<DecisionView, "question" | "itemTitle">): QuestionLines {
  const split = splitLead(plainStatusWords(d.question));
  const titled = !split.whole && !!d.itemTitle && !sameLabel(d.itemTitle, d.question);
  return { title: titled ? d.itemTitle! : split.lead, rest: split.rest, titled, readable: split.whole && !split.rest };
}

/** The item a decision is about, unless its title only restates the question (or already heads the row). */
export function aboutItem(d: Pick<DecisionView, "question" | "itemTitle" | "areaTitle">, titled = false): string | null {
  if (titled || !d.itemTitle || sameLabel(d.itemTitle, d.question)) return d.areaTitle ?? null;
  return d.itemTitle;
}

/**
 * The choices a ROW may offer as one-tap chips: none for a risky decision (it opens the card, where the answer
 * takes a second tap), none when the question is not readable on the row (a tap on half a sentence is a blind answer).
 */
export function rowChoices(d: Pick<DecisionView, "risk" | "choices" | "question" | "itemTitle">): string[] {
  if (isRiskyDecision(d) || !questionLines(d).readable) return [];
  return d.choices;
}

export type AnswerGate = "send" | "confirm" | "empty";

/**
 * May this answer be sent now? "confirm" = the decision is risk-flagged and the owner has not made the second,
 * explicit tap yet. Free text is held to the same rule as a listed choice.
 */
export function answerGate(d: Pick<DecisionView, "risk">, answer: string, confirmed = false): AnswerGate {
  if (!answer.trim()) return "empty";
  return isRiskyDecision(d) && !confirmed ? "confirm" : "send";
}

/**
 * What was asked, short enough for one line: the question when it is brief, else its first sentence, else the
 * item it is about (a paragraph cut mid-sentence says less than the item's name).
 */
export function shortQuestion(d: Pick<DecisionView, "question" | "itemTitle">): string {
  const asked = splitLead(plainStatusWords(d.question), 70);
  return asked.whole ? asked.lead : (d.itemTitle ?? asked.lead);
}

/** The one receipt, on every surface: what was asked, then what was answered. "D-52 · Budget ceiling for the desk · Up to $400". */
export const receiptText = (d: Pick<DecisionView, "ref" | "question" | "itemTitle">, choice: string) => `${d.ref} · ${shortQuestion(d)} · ${choice}`;

/** Where a surface with no composer of its own sends "Something else…": the Chief of staff, open on this decision. */
export const askHref = (ref: string) => `?coord=needs&d=${encodeURIComponent(ref)}`;
