/**
 * How raw message / agent text is shown to the owner. Pure and client-safe: nothing here changes
 * what is stored or sent, only what the eye has to read.
 */

export type UserMessageParts = {
  /** "[Viewing: Today — /home]" page context the coordinator composer prepends (lib/coordinator/page-context.ts). */
  context: { label: string; path: string } | null;
  /** The receipt a one-tap decision answer posts for the agent (components/map/Decisions.tsx + lib/decisions.ts). */
  decision: { title: string; question: string; answer: string } | null;
  /** What the person actually typed (empty for a pure decision receipt). */
  text: string;
};

const VIEWING = /^\[Viewing: ([^\]\r\n]{1,300}?) — ([^\]\r\n]{1,300})\]\r?\n?/;
const DECISION = /^Decision on "([\s\S]{1,300}?)": Decision: ([\s\S]*) → ([^→]+)$/;

/** Splits the machine-written wrapper off a sent message. Unknown shapes come back untouched in `text`. */
export function parseUserMessage(raw: string): UserMessageParts {
  let text = raw;
  let context: UserMessageParts["context"] = null;
  const viewing = VIEWING.exec(text);
  if (viewing) {
    context = { label: viewing[1].trim(), path: viewing[2].trim() };
    text = text.slice(viewing[0].length);
  }
  const decision = DECISION.exec(text.trim());
  if (decision) return { context, decision: { title: decision[1].trim(), question: decision[2].trim(), answer: decision[3].trim() }, text: "" };
  return { context, decision: null, text };
}

/** Separator the composers put between the typed message and the context/files Jarvis attached for the model. */
export const ATTACHED_CONTEXT_MARK = "\n\n---\nContext from Jarvis:";

/** The typed part of a sent message, and the attached block (file markers, context lines) after it. */
export function splitAttachedContext(text: string): { body: string; attached: string } {
  const at = text.indexOf(ATTACHED_CONTEXT_MARK);
  return at < 0 ? { body: text, attached: "" } : { body: text.slice(0, at), attached: text.slice(at + ATTACHED_CONTEXT_MARK.length).trim() };
}

/** Work statuses agents paste verbatim into prose (server/work/lifecycle.ts). Only these are rewritten. */
const STATUS_WORDS: Record<string, string> = {
  ready_to_settle: "ready to settle",
  awaiting_validation: "awaiting validation",
  in_progress: "in progress",
  in_review: "in review",
  on_hold: "on hold",
};
const STATUS_RE = new RegExp(`\\b(${Object.keys(STATUS_WORDS).join("|")})\\b`, "g");

/** `ready_to_settle` → "ready to settle" in agent-written prose. Code spans are left alone. */
export function plainStatusWords(text: string): string {
  return text
    .split(/(`[^`\n]*`)/g)
    .map((part) => (part.startsWith("`") ? part : part.replace(STATUS_RE, (m) => STATUS_WORDS[m] ?? m)))
    .join("");
}

/** `whole`: the lead is complete text (all of it, or a full first sentence), not a mid-sentence cut. */
export type LeadSplit = { lead: string; rest: string; whole: boolean };

/**
 * Agents sometimes put a whole paragraph in a one-line field (a decision "question", a run summary).
 * Returns a short lead to show as the heading and the remainder to show as body text. Short text is
 * returned whole; nothing is ever dropped.
 */
export function splitLead(text: string, max = 110): LeadSplit {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { lead: flat, rest: "", whole: true };
  // First sentence end that leaves a meaningful lead; "e.g." / "v2.1" style dots are followed by a non-space.
  const sentence = /^(.{12,}?[.?!])\s+(?=\S)/.exec(flat);
  if (sentence && sentence[1].length <= max) return { lead: sentence[1], rest: flat.slice(sentence[0].length).trim(), whole: true };
  const cut = flat.lastIndexOf(" ", max);
  const at = cut > max * 0.6 ? cut : max;
  return { lead: `${flat.slice(0, at).trimEnd()}…`, rest: flat, whole: false };
}

/** Case/punctuation-insensitive "these two labels say the same thing" (a decision whose question repeats its item title). */
export function sameLabel(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  if (!a || !b) return false;
  const x = norm(a);
  const y = norm(b);
  // "Decide: move staging to the new region" restates the item "Move staging to the new region".
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // Contained and most of it: a title merely mentioned inside a long paragraph is not a restatement.
  return !!x && (x === y || (short.length >= 12 && short.length >= long.length * 0.5 && long.includes(short)));
}

/**
 * One line of what the person actually asked, for status lines and list rows: the "[Viewing: …]"
 * wrapper is dropped and a decision receipt reads as the choice made. Falls back to the raw text.
 */
export function plainMessageLine(raw: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = parseUserMessage(raw);
  if (parts.decision) return `Decided: ${flat(parts.decision.answer)}`;
  return flat(parts.text) || (parts.context ? `Viewing ${parts.context.label}` : flat(raw));
}

const CRON_DELIVERY = /^\[Cron delivery:\s*([^\]\r\n]{1,200})\]\s*/i;

/**
 * A conversation a scheduled job delivered into: Hermes titles these "[Cron delivery: <job>] …".
 * That explicit prefix is the only signal the list data carries, so nothing else is guessed.
 * Returns the job name and the title without the wrapper (the job name when nothing follows it).
 */
export function scheduledTitle(title: string): { job: string; title: string } | null {
  const m = CRON_DELIVERY.exec(title.trimStart());
  if (!m) return null;
  const job = m[1].trim();
  return { job, title: title.trimStart().slice(m[0].length).trim() || job };
}

/** Who answers a conversation, as the composer and the empty state name them: "@profile", "Claude" or the assistant. */
export function answererName(x: { agentProfile?: string | null; assistant: string }): string {
  return x.agentProfile ? `@${x.agentProfile}` : x.assistant;
}
