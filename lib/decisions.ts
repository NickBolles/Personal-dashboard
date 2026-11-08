/**
 * Decisions inbox ("Needs you"): client-safe types and pure helpers. A work
 * item can carry an owner decision (question + optional one-tap choices); the
 * inbox also lists Hermes approvals and workflow proposals. Answering never
 * settles anything and never posts to a conversation without an explicit confirm.
 */
import { z } from "zod";

/**
 * A server-built, tappable next step for a decision (e.g. an agent's device
 * proposal → "Confirm on House"). Never accepted from request bodies: only
 * Jarvis code sets it, and only same-origin paths survive parsing.
 */
export type DecisionAction = { label: string; href: string };

/** `detail` = the full proposed content (e.g. a scheduled job's note body), shown with the question. */
export type ItemDecision = { question: string; choices: string[]; askedAt: string; detail?: string; action?: DecisionAction };

/** Same-origin app path only ("/x…", never "//host" or a scheme). */
export const isAppPath = (href: unknown): href is string => typeof href === "string" && href.length <= 600 && /^\/(?![/\\])[^\s\\]*$/.test(href);

function parseAction(v: unknown): DecisionAction | undefined {
  if (!v || typeof v !== "object") return undefined;
  const a = v as Partial<DecisionAction>;
  if (typeof a.label !== "string" || !a.label.trim() || !isAppPath(a.href)) return undefined;
  return { label: a.label.trim().slice(0, 60), href: a.href };
}
export const DECISION_DETAIL_MAX = 4000;

export const decisionInputSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    choices: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
    detail: z.string().trim().max(DECISION_DETAIL_MAX).optional(),
  })
  .strict();

export const decisionAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(2000),
    /** also post the answer to the item's linked Hermes conversation (the client asks first) */
    postToConversation: z.boolean().optional(),
  })
  .strict();

export function parseDecision(raw: string | null | undefined): ItemDecision | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ItemDecision>;
    if (!v || typeof v.question !== "string" || !v.question.trim()) return null;
    const choices = Array.isArray(v.choices) ? v.choices.filter((c): c is string => typeof c === "string" && !!c.trim()) : [];
    const detail = typeof v.detail === "string" && v.detail.trim() ? { detail: v.detail.slice(0, DECISION_DETAIL_MAX) } : {};
    const action = parseAction(v.action);
    return { question: v.question, choices, askedAt: typeof v.askedAt === "string" ? v.askedAt : "", ...detail, ...(action ? { action } : {}) };
  } catch {
    return null;
  }
}

export function serialiseDecision(d: { question: string; choices?: string[]; detail?: string; action?: DecisionAction }, askedAt: string): string {
  const choices = [...new Set((d.choices ?? []).map((c) => c.trim()).filter(Boolean))];
  const detail = d.detail?.trim().slice(0, DECISION_DETAIL_MAX);
  const action = parseAction(d.action);
  return JSON.stringify({ question: d.question.trim(), choices, askedAt, ...(detail ? { detail } : {}), ...(action ? { action } : {}) });
}

/** The line appended to the item's summary (and the activity reason) when a decision is answered. */
export const decisionLogText = (question: string, answer: string) => `Decision: ${question.trim()} → ${answer.trim()}`;

export function appendDecisionToSummary(summary: string, question: string, answer: string, at: string): string {
  const line = `- ${at.slice(0, 10)} · ${decisionLogText(question, answer)}`;
  const base = summary.trimEnd();
  return base ? `${base}\n\n${line}` : line;
}

/** `stalled` = an agent run still "running" with no update for STALL_AFTER_MIN (a nudge: opening the item is the only action). */
export type DecisionKind = "item" | "approval" | "workflow" | "stalled";

export type DecisionEntry = {
  /** stable key: `item:<id>` | `approval:<runId>` | `workflow:<runId>` | `stalled:<agentRunId>` */
  key: string;
  kind: DecisionKind;
  title: string;
  question: string;
  /** full proposed content behind an item decision (scheduled-job proposals), when there is one */
  detail?: string;
  choices: string[];
  /** where answering happens for approvals/workflows (they keep their own flows) */
  href: string;
  /** a server-built next step for an item decision (e.g. "Confirm on House" for a device proposal) */
  action?: DecisionAction;
  at: string;
  itemId?: string;
  areaTitle?: string;
  /** the item's linked Hermes conversation, when it has one (answer can be posted there after confirm) */
  sessionId?: string | null;
  /** the item's area coordinator conversation (answer can be posted there after confirm when the item has none) */
  coordinatorSessionId?: string | null;
  /** Profile that raised this question, from its decision-request activity event (not the latest item editor). */
  askedBy?: string;
};

export type DecisionsResponse = { entries: DecisionEntry[]; count: number };

/** Newest first, with owner item decisions grouped before approvals and workflow proposals at the same time. */
export function sortDecisions(entries: DecisionEntry[]): DecisionEntry[] {
  return [...entries].sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at < b.at ? 1 : -1));
}

/** Undo of an answer withdraws its pending conversation post (#167); other offers stay. */
export function withdrawPost<T extends { opId: string }>(posted: T | null, undoneOpId: string): T | null {
  return posted && posted.opId === undoneOpId ? null : posted;
}
