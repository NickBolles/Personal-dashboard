/**
 * Settle policy per area (docs/work.md "Settle policy"). Pure and unit tested:
 * the store loads the facts, these decide.
 *
 * Deterministic signals only (owner decision, phase 4): an implementation PR is
 * merged, the settle gate passes (every validation passes or is waived, and a
 * packet that requires validation has at least one), and nothing happened on
 * the item for the area's quiet period. A cheap model check could refine the
 * suggestion later, but it needs model-spend approval: `settleModelCheck` is
 * the hook and always answers "no opinion" today.
 */
import type { SettlePolicy, WorkStatus } from "@/lib/work";
import { isClosed } from "@/lib/work";

export const DAY_MS = 86_400_000;
/** Auto-settled work can be undone (reopened to its previous status) for this long. */
export const AUTO_SETTLE_UNDO_MS = 7 * DAY_MS;

export type SettleFacts = {
  status: WorkStatus;
  kind: string;
  archived: boolean;
  /** a linked implementation PR is merged */
  merged: boolean;
  /** settleGate(...).allowed */
  gateAllowed: boolean;
  /** latest activity on the item (events, edits), ISO */
  lastActivityAt: string;
};

export type SettleSignals = { ready: boolean; quiet: boolean; quietForDays: number; reasons: string[] };

/** Which deterministic signals hold for an item, and for how long it has been quiet. */
export function settleSignals(f: SettleFacts, quietDays: number, now: Date): SettleSignals {
  const reasons: string[] = [];
  const quietForDays = Math.max(0, Math.floor((now.getTime() - new Date(f.lastActivityAt).getTime()) / DAY_MS));
  if (f.kind === "area" || f.archived || isClosed(f.status)) return { ready: false, quiet: false, quietForDays, reasons };
  if (f.merged) reasons.push("PR merged");
  if (f.gateAllowed) reasons.push("validations pass");
  const ready = f.merged && f.gateAllowed;
  const quiet = quietForDays >= quietDays;
  if (ready && quiet) reasons.push(`quiet for ${quietForDays} day${quietForDays === 1 ? "" : "s"}`);
  return { ready, quiet, quietForDays, reasons };
}

/** Optional refinement hook (model check). Out of scope until model spend is approved: never has an opinion. */
export function settleModelCheck(_facts: SettleFacts): "settle" | "keep" | null {
  return null;
}

/** What the area's policy does with the signals: nothing, a suggestion, or an automatic settle. */
export function settleDecision(policy: SettlePolicy, s: SettleSignals, facts: SettleFacts): "none" | "suggest" | "auto" {
  if (!s.ready || !s.quiet || policy === "manual") return "none";
  if (settleModelCheck(facts) === "keep") return "none";
  return policy === "auto_after_quiet" ? "auto" : "suggest";
}
