import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { decisionRef, parseChoices, parseDecisionRef, parseRisk } from "@/lib/cw-decisions";
import { detectSensitivity } from "@/server/ai/rules";
import { maskAccountNumbers } from "@/lib/ai-redact";

/** At most this many one-tap answers on a push (browsers show two notification actions). */
const MAX_ACTIONS = 2;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * CW-5 one-tap answers on a decision push, decided at DELIVERY time (the decision may have changed since it
 * was raised): only an OPEN, LOW-RISK decision with choices gets actions (recommended choice first). A
 * risk-flagged decision never does: its push only opens the detail, where answering needs Confirm. The
 * answer route enforces the same rule for `via: "push"`.
 */
export function decisionPushActions(userId: string, dedupeKey: string | null | undefined) {
  const ref = dedupeKey?.startsWith("cw:decision:") ? dedupeKey.slice("cw:decision:".length) : null;
  const seq = ref ? parseDecisionRef(ref) : null;
  if (!ref || seq === null) return null;
  const d = getDb()
    .select()
    .from(schema.decisions)
    .where(and(eq(schema.decisions.userId, userId), eq(schema.decisions.seq, seq)))
    .get();
  if (!d || d.state !== "open" || parseRisk(d.riskJson).length > 0) return null;
  const choices = parseChoices(d.choicesJson);
  if (!choices.length) return null;
  const ordered = d.recommended && choices.includes(d.recommended) ? [d.recommended, ...choices.filter((c) => c !== d.recommended)] : choices;
  const picked = ordered.slice(0, MAX_ACTIONS);
  // Choice text leaves Jarvis in the push payload: a credential-like or account-number choice suppresses the
  // actions (never a masked answer, which the answer route would reject); the push still opens the detail.
  if (picked.some((c) => detectSensitivity(c) === "credentials" || maskAccountNumbers(c) !== c)) return null;
  return {
    ref: decisionRef(d.seq),
    actions: picked.map((c, i) => ({ action: `answer:${i}`, title: clip(c, 32) })),
    answers: Object.fromEntries(picked.map((c, i) => [`answer:${i}`, c])),
  };
}
