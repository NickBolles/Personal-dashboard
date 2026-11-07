import type { DecisionEntry } from "./decisions";

/** DecisionEntry.key is the stable public route id; slashes, dots, whitespace and extra colons are never accepted. */
export const DECISION_ROUTE_ID = /^(?:item|approval|workflow|stalled):[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;
export const validDecisionId = (id: string) => DECISION_ROUTE_ID.test(id);
export const decisionHref = (entry: Pick<DecisionEntry, "key">) => `/decisions/${encodeURIComponent(entry.key)}`;
