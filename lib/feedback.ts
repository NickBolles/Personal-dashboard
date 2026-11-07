/**
 * Feedback loop (owner ask 2026-11-07): rate any assistant message 👍/👎 with
 * quick reasons and a note, ask the same agent to fix it, review everything in
 * the Feedback inbox, and let a (disabled by default) daily triage job send new
 * 👎 to the Chief of staff. Shared contract (server + client) + pure logic.
 *
 * Rules:
 * - Ratings are the rater's own (user-scoped); nothing leaves Jarvis until the
 *   owner asks to fix (confirmed send) or enables the triage job.
 * - The triage payload never includes feedback from AI-excluded areas or text
 *   that trips the sensitivity filter (the server filters before building it).
 * - Triage never applies code, merges or deploys: it files items and proposes.
 */
import { z } from "zod";

export const FEEDBACK_RATINGS = ["up", "down"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const FEEDBACK_REASONS = ["wrong", "didnt_do_it", "too_long", "ugly_ui", "slow", "other"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  wrong: "Wrong",
  didnt_do_it: "Didn't do it",
  too_long: "Too long",
  ugly_ui: "Ugly UI",
  slow: "Slow",
  other: "Other",
};

export const FEEDBACK_STATUSES = ["new", "triaged", "fixed", "wont_fix"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "New",
  triaged: "Triaged",
  fixed: "Fixed",
  wont_fix: "Won't fix",
};

export const FEEDBACK_SURFACES = ["chat", "coordinator", "card"] as const;
export type FeedbackSurface = (typeof FEEDBACK_SURFACES)[number];
export const FEEDBACK_SURFACE_LABELS: Record<FeedbackSurface, string> = { chat: "Chat", coordinator: "Coordinator", card: "Smart card" };

/** Stored excerpt of the rated reply (plain text, enough to recognise it). */
export const FEEDBACK_EXCERPT_MAX = 600;
export const FEEDBACK_NOTE_MAX = 2000;
/** Most feedback entries one triage run reads (oldest first; the rest wait for the next run). */
export const TRIAGE_MAX_ENTRIES = 30;

const sessionId = z.string().min(1).max(200);
const messageId = z.string().min(1).max(200);

export const rateInputSchema = z
  .object({
    sessionId,
    messageId,
    surface: z.enum(FEEDBACK_SURFACES),
    rating: z.enum(FEEDBACK_RATINGS),
    reasons: z.array(z.enum(FEEDBACK_REASONS)).max(FEEDBACK_REASONS.length).default([]),
    note: z.string().trim().max(FEEDBACK_NOTE_MAX).default(""),
    /** the rated reply's text; the server trims it to an excerpt */
    text: z.string().max(50_000).default(""),
    model: z.string().max(100).optional(),
    /** tool names used for this reply (summary only, never inputs/outputs) */
    tools: z.array(z.string().max(80)).max(50).default([]),
  })
  .strict();
export type RateInput = z.input<typeof rateInputSchema>;

export const feedbackPatchSchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    reasons: z.array(z.enum(FEEDBACK_REASONS)).max(FEEDBACK_REASONS.length).optional(),
    note: z.string().trim().max(FEEDBACK_NOTE_MAX).optional(),
    /** set when the owner sent "Ask to fix" for this rating */
    fixRequested: z.boolean().optional(),
  })
  .strict();
export type FeedbackPatch = z.infer<typeof feedbackPatchSchema>;

export const feedbackFilterSchema = z.object({
  rating: z.enum(FEEDBACK_RATINGS).optional(),
  status: z.enum(FEEDBACK_STATUSES).optional(),
  reason: z.enum(FEEDBACK_REASONS).optional(),
  profile: z.string().max(80).optional(),
  areaId: z.string().max(64).optional(),
  sessionId: sessionId.optional(),
});
export type FeedbackFilter = z.infer<typeof feedbackFilterSchema>;

/** One rating as the API returns it. */
export type Feedback = {
  id: string;
  sessionId: string;
  messageId: string;
  surface: FeedbackSurface;
  rating: FeedbackRating;
  reasons: FeedbackReason[];
  note: string;
  excerpt: string;
  /** Hermes profile the conversation runs on ("default" when unrouted) */
  profile: string;
  areaId: string | null;
  areaTitle: string | null;
  model: string | null;
  tools: string[];
  status: FeedbackStatus;
  fixRequestedAt: string | null;
  /** the Jarvis item made from this rating (null when none or archived) */
  itemId: string | null;
  itemTitle: string | null;
  triagedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackList = {
  entries: Feedback[];
  counts: { total: number; down: number; newDown: number };
  /** filter options from the rater's own feedback */
  profiles: string[];
  areas: { id: string; title: string }[];
};

/** Status changes are free in every direction (the owner reviews by hand), except to the same status. */
export function canTransition(from: FeedbackStatus, to: FeedbackStatus) {
  return from !== to;
}

/** Plain-text excerpt of a reply: drops fenced blocks (smart cards, proposals) and markdown punctuation. */
export function excerptOf(text: string, max = FEEDBACK_EXCERPT_MAX) {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

export function reasonsText(reasons: readonly FeedbackReason[]) {
  return reasons.map((r) => FEEDBACK_REASON_LABELS[r]).join(", ");
}

/** The follow-up "Ask to fix" sends into the same conversation (editable before sending). */
export function fixPrompt(f: { reasons: readonly FeedbackReason[]; note: string; excerpt: string }) {
  const why = f.reasons.length ? reasonsText(f.reasons) : "Not right";
  const lines = [
    `Feedback on your previous reply: rated bad (${why}).`,
    f.excerpt ? `Your reply began: "${excerptOf(f.excerpt, 160)}"` : "",
    f.note ? `What went wrong: ${f.note}` : "",
    reasonInstruction(f.reasons),
    "Please correct it now, and say briefly what you changed.",
  ];
  return lines.filter(Boolean).join("\n");
}

function reasonInstruction(reasons: readonly FeedbackReason[]) {
  if (reasons.includes("didnt_do_it")) return "You didn't actually do what I asked. Do it now, or tell me exactly what blocked you.";
  if (reasons.includes("wrong")) return "You got this wrong. Check your facts before answering again.";
  if (reasons.includes("too_long")) return "That was too long. Give me the short version.";
  if (reasons.includes("ugly_ui")) return "The way it was presented was hard to use. Present it more cleanly.";
  return "";
}

/** One 👎 as the triage job receives it. */
export type TriageEntry = {
  id: string;
  createdAt: string;
  surface: FeedbackSurface;
  profile: string;
  areaTitle: string | null;
  model: string | null;
  reasons: FeedbackReason[];
  note: string;
  excerpt: string;
  tools: string[];
  /** deep link back to the rated message */
  link: string;
};

export function messageLink(origin: string, sessionId: string, messageId: string) {
  const base = origin.replace(/\/$/, "");
  // Smart cards (DynamicSurface) carry a synthetic `dynamic:<cardId>` id: they open from More, not a chat.
  if (sessionId.startsWith("dynamic:")) return `${base}/more?smartCard=${encodeURIComponent(sessionId.slice(8))}`;
  return `${base}/chat/${encodeURIComponent(sessionId)}#msg-${encodeURIComponent(messageId)}`;
}

/**
 * The input block a "Daily feedback triage" run gets after the job's prompt.
 * Pure: the server has already dropped excluded/sensitive entries.
 */
export function buildTriagePayload(entries: readonly TriageEntry[], since: string | null) {
  if (!entries.length) return "";
  const list = entries
    .slice(0, TRIAGE_MAX_ENTRIES)
    .map((e, i) =>
      [
        `${i + 1}. [${e.id}] ${e.createdAt.slice(0, 16).replace("T", " ")} UTC · ${FEEDBACK_SURFACE_LABELS[e.surface]} · @${e.profile}${e.areaTitle ? ` · ${e.areaTitle}` : ""}${e.model ? ` · ${e.model}` : ""}`,
        `   Reasons: ${e.reasons.length ? reasonsText(e.reasons) : "none given"}`,
        e.note ? `   Owner note: ${e.note.replace(/\s+/g, " ")}` : "",
        e.excerpt ? `   Reply excerpt: ${excerptOf(e.excerpt, 300)}` : "",
        e.tools.length ? `   Tools used: ${[...new Set(e.tools)].slice(0, 12).join(", ")}` : "",
        `   Message: ${e.link}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  const more = entries.length > TRIAGE_MAX_ENTRIES ? `\n(${entries.length - TRIAGE_MAX_ENTRIES} more wait for the next run.)` : "";
  return (
    [`New thumbs-down feedback${since ? ` since ${since.slice(0, 10)}` : ""} (${Math.min(entries.length, TRIAGE_MAX_ENTRIES)}):`, ...list].join("\n\n") + more
  );
}

/** Template seeded (disabled) for the owner; runs on the Chief of staff coordinator area. */
export const FEEDBACK_TRIAGE_TEMPLATE = {
  key: "daily-feedback-triage",
  title: "Daily feedback triage",
  kind: "feedback" as const,
  overnight: false,
  schedule: { freq: "daily" as const, time: "06:00", days: [] as number[] },
  prompt:
    "Daily feedback triage. Below is the owner's new thumbs-down feedback on assistant replies. " +
    "Cluster the entries by likely root cause (prompt/skill, tool or integration bug, UI, model choice, missing data). " +
    "Use read tools (e.g. jarvis_search) to find existing Jarvis items for each cluster. " +
    "Then propose: create_thread (or update_next_action on the existing item) per cluster, with the feedback ids and message links in the text, " +
    "and a decision for the owner per proposed fix (what to change, where, and whether to delegate a code fix through the normal PR process). " +
    "Never change code, merge or deploy yourself. If a cluster is a one-off, say so and propose nothing for it. " +
    "If there is no feedback below, say exactly NOTHING_NEW.",
};
