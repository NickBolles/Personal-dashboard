/**
 * Shared (client + server) vocabulary for Home prioritization and feedback.
 * The ranking itself lives in server/ranking/attention.ts.
 */
import { SOURCE_LABELS, type ActionSource } from "./contracts";

export const ATTENTION_VERSION = 1;

export const FEEDBACK_VERDICTS = ["helpful", "not_helpful", "not_now", "less_like_this", "wrong_assumption"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const VERDICT_LABELS: Record<FeedbackVerdict, string> = {
  helpful: "Helpful",
  not_helpful: "Not helpful",
  not_now: "Not now",
  less_like_this: "Less like this",
  wrong_assumption: "Wrong assumption",
};

/** −2 hides a category's non-urgent items from Now/Today; +1 lifts it within its tier. */
export const MIN_WEIGHT = -2;
export const MAX_WEIGHT = 1;

export const WEIGHT_LABELS: Record<string, string> = {
  "1": "A bit earlier",
  "0": "Normal",
  "-1": "A bit later",
  "-2": "Out of Now and Today",
};

export const ASSIST_CATEGORIES = {
  "assist:overdue_triage": "Overdue triage suggestions",
  "assist:plan_ahead": "Plan-ahead suggestions",
  "assist:seasonal": "Seasonal ideas",
} as const;

/** Feedback category for an action: its source. */
export function actionCategory(source: ActionSource) {
  return `source:${source}`;
}

export function categoryLabel(category: string) {
  if (category in ASSIST_CATEGORIES) return ASSIST_CATEGORIES[category as keyof typeof ASSIST_CATEGORIES];
  const source = category.startsWith("source:") ? (category.slice(7) as ActionSource) : undefined;
  return source && SOURCE_LABELS[source] ? SOURCE_LABELS[source] : category;
}

/** Feedback categories a person can tune: every source plus the suggestion kinds. */
export function tunableCategories(sources: ActionSource[]) {
  return [...sources.map(actionCategory), ...Object.keys(ASSIST_CATEGORIES)];
}

export const CATEGORY_PATTERN = /^(source|assist):[a-z_]{2,40}$/;
