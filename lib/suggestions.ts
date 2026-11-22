import { z } from "zod";

/**
 * Suggestions (task threads H1-H8, docs/home-priorities.md): a coordinator's idea for its channel, drawn on the
 * agent surface. The owner Starts or Sends it with their own tap; Jarvis never applies one by itself.
 */

/** Open per channel (H3); a sixth replaces the weakest. */
export const SUGGESTIONS_PER_CHANNEL = 5;
/** Not now hides a suggestion this long (H5). */
export const NOT_NOW_MS = 7 * 86_400_000;
/** A suggestion nobody acted on goes stale after this (H6). */
export const SUGGESTION_MAX_AGE_MS = 14 * 86_400_000;
/** A started suggestion stays on screen as a done card (with Undo) this long. */
export const DONE_CARD_MS = 15 * 60_000;

export const SUGGESTION_ACTS = ["start", "steer"] as const;
export type SuggestionAct = (typeof SUGGESTION_ACTS)[number];

/** A suggestion as the screens draw it. */
export type Suggestion = {
  id: string;
  channelId: string;
  channelTitle: string;
  /** "Home coordinator suggests", "Chief of staff suggests" */
  who: string;
  topic: string;
  act: SuggestionAct;
  /** the task it starts or steers; null: Start creates a task titled `title` */
  itemId: string | null;
  itemTitle: string | null;
  title: string;
  why: string;
  /** exactly what the agent is told */
  brief: string;
  /** the owner's own tasks the reason is drawn from */
  evidence: { id: string; title: string }[];
  state: "open" | "started";
  createdAt: string;
  /** other open suggestions in this channel, behind "more" */
  more: number;
  /** after Start or Send */
  result?: { itemId: string; title: string; href: string; undoable: boolean; at: string };
};

export type SuggestionsResponse = { suggestions: Suggestion[] };

export const suggestionActionSchema = z
  .object({ action: z.enum(["start", "not_now", "show_again", "stop_topic", "allow_topic", "undo"]) })
  .strict();
export type SuggestionAction = z.infer<typeof suggestionActionSchema>["action"];

/** The primary action's word: Start a task, Send a steer. */
export const suggestionVerb = (s: Pick<Suggestion, "act">) => (s.act === "steer" ? "Send" : "Start");
