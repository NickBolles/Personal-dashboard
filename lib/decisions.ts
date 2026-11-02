/**
 * Decisions inbox ("Needs you"): client-safe types and pure helpers. A work
 * item can carry an owner decision (question + optional one-tap choices); the
 * inbox also lists Hermes approvals and workflow proposals. Answering never
 * settles anything and never posts to a conversation without an explicit confirm.
 */
import { z } from "zod";

export type ItemDecision = { question: string; choices: string[]; askedAt: string };

export const decisionInputSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    choices: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
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
    return { question: v.question, choices, askedAt: typeof v.askedAt === "string" ? v.askedAt : "" };
  } catch {
    return null;
  }
}

export function serialiseDecision(d: { question: string; choices?: string[] }, askedAt: string): string {
  const choices = [...new Set((d.choices ?? []).map((c) => c.trim()).filter(Boolean))];
  return JSON.stringify({ question: d.question.trim(), choices, askedAt });
}

/** The line appended to the item's summary (and the activity reason) when a decision is answered. */
export const decisionLogText = (question: string, answer: string) => `Decision: ${question.trim()} → ${answer.trim()}`;

export function appendDecisionToSummary(summary: string, question: string, answer: string, at: string): string {
  const line = `- ${at.slice(0, 10)} · ${decisionLogText(question, answer)}`;
  const base = summary.trimEnd();
  return base ? `${base}\n\n${line}` : line;
}

export type DecisionKind = "item" | "approval" | "workflow";

export type DecisionEntry = {
  /** stable key: `item:<id>` | `approval:<runId>` | `workflow:<runId>` */
  key: string;
  kind: DecisionKind;
  title: string;
  question: string;
  choices: string[];
  /** where answering happens for approvals/workflows (they keep their own flows) */
  href: string;
  at: string;
  itemId?: string;
  areaTitle?: string;
  /** the item's linked Hermes conversation, when it has one (answer can be posted there after confirm) */
  sessionId?: string | null;
};

export type DecisionsResponse = { entries: DecisionEntry[]; count: number };

/** Newest first, with owner item decisions grouped before approvals and workflow proposals at the same time. */
export function sortDecisions(entries: DecisionEntry[]): DecisionEntry[] {
  return [...entries].sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at < b.at ? 1 : -1));
}
