import type { DecisionEntry } from "./decisions";

/** DecisionEntry.key is the stable public route id; slashes, dots, whitespace and extra colons are never accepted. */
export const DECISION_ROUTE_ID = /^(?:item|approval|workflow|stalled|decision):[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;
export const validDecisionId = (id: string) => DECISION_ROUTE_ID.test(id);
/** Next can hand a dynamic segment over still percent-encoded ("item%3Awk_…"); a malformed escape stays as-is (and fails validDecisionId). */
export function decodeDecisionId(raw: string) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
export const decisionHref = (entry: Pick<DecisionEntry, "key">) => `/decisions/${encodeURIComponent(entry.key)}`;
