/**
 * Work lifecycle rules (docs/work.md). Pure functions only: the store
 * (server/work/store.ts) loads rows, asks these what to do, then writes the
 * item, a work_events row and an audit entry in one transaction.
 */
import { comparatorPasses, isClosed, STATUS_LABELS, type Comparator, type ValidationStatus, type WorkStatus } from "@/lib/work";

export class LifecycleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type PacketLike = { validationRequired: boolean } | null | undefined;
type ValidationLike = { status: ValidationStatus };

export type SettledPatch = {
  status: WorkStatus;
  /** new settlements are always "manual"; "auto" only exists on legacy rows */
  settledKind: "manual" | "auto" | null;
  settledReason: string | null;
  completedAt: string | null;
};

/** Settle needs every validation to be pass or waived; a packet that requires validation needs at least one. */
export function settleGate(latestPacket: PacketLike, validations: ValidationLike[]): { allowed: boolean; reason: string | null } {
  const open = validations.filter((v) => v.status !== "pass" && v.status !== "waived");
  if (open.some((v) => v.status === "fail")) return { allowed: false, reason: "A validation failed. Reopen, or waive it with a reason." };
  if (open.length) return { allowed: false, reason: `${open.length} validation${open.length === 1 ? "" : "s"} still pending.` };
  if (latestPacket?.validationRequired && !validations.length) return { allowed: false, reason: "The work packet requires validation. Add one first." };
  return { allowed: true, reason: null };
}

/**
 * A linked implementation PR merged. A merge is not proof of outcome, and
 * settling is always the person's call (owner decision: auto-settle never):
 * unless the latest packet explicitly says no validation is needed (and
 * nothing is pending), the item waits for validation; otherwise it becomes
 * `ready_to_settle` and the item shows a "PR merged — settle?" prompt.
 * Nothing here ever returns `settled`.
 */
export function onImplementationMerged(input: {
  status: WorkStatus;
  latestPacket: PacketLike;
  validations: ValidationLike[];
  prNumber: number | null;
  at: string;
}): (SettledPatch & { reason: string }) | null {
  if (isClosed(input.status)) return null;
  const pr = input.prNumber ? `PR #${input.prNumber}` : "PR";
  // No packet means nobody declared "no validation needed": default to required.
  const required = input.latestPacket ? input.latestPacket.validationRequired : true;
  const unresolved = input.validations.some((v) => v.status === "pending" || v.status === "fail");
  if (required || unresolved) {
    if (input.status === "awaiting_validation") return null;
    return { status: "awaiting_validation", settledKind: null, settledReason: null, completedAt: null, reason: `${pr} merged; awaiting validation` };
  }
  if (input.status === "ready_to_settle") return null;
  return {
    status: "ready_to_settle",
    settledKind: null,
    settledReason: null,
    completedAt: null,
    reason: `${pr} merged; no validation required. Settle when you're satisfied`,
  };
}

/** Recording an observed value decides pass/fail; a waiver needs a reason. */
export function evaluateValidation(v: { comparator: Comparator; threshold: number; observed: number | null; waive?: boolean; waiverReason?: string | null }): {
  status: ValidationStatus;
  waiverReason: string | null;
} {
  if (v.waive) {
    if (!v.waiverReason?.trim()) throw new LifecycleError("waiver_reason", "A waiver needs a reason");
    return { status: "waived", waiverReason: v.waiverReason.trim() };
  }
  if (v.observed === null || v.observed === undefined || !Number.isFinite(v.observed)) return { status: "pending", waiverReason: null };
  return { status: comparatorPasses(v.comparator, v.observed, v.threshold) ? "pass" : "fail", waiverReason: null };
}

/**
 * Validate a requested status change and compute the settlement fields.
 * Settling goes through the gate; ready/in_progress need a next action.
 */
export function planTransition(input: {
  from: WorkStatus;
  to: WorkStatus;
  nextAction: string;
  latestPacket: PacketLike;
  validations: ValidationLike[];
  reason?: string | null;
  at: string;
}): SettledPatch {
  const { to } = input;
  if ((to === "ready" || to === "in_progress") && !input.nextAction.trim())
    throw new LifecycleError("next_action_required", `${STATUS_LABELS[to]} needs a next action`);
  if (to === "settled") {
    if (input.from === "settled") throw new LifecycleError("already_settled", "Already settled");
    const gate = settleGate(input.latestPacket, input.validations);
    if (!gate.allowed) throw new LifecycleError("settle_blocked", gate.reason!);
    return { status: "settled", settledKind: "manual", settledReason: input.reason?.trim() || null, completedAt: input.at };
  }
  if (to === "reopened" && !input.reason?.trim()) throw new LifecycleError("reason_required", "Say why it's reopening");
  const terminal = to === "superseded" || to === "abandoned";
  return { status: to, settledKind: null, settledReason: null, completedAt: terminal ? input.at : null };
}

/** True if putting `id` under `newParentId` would make an item its own ancestor. */
export function wouldCreateCycle(parents: Map<string, string | null>, id: string, newParentId: string | null) {
  let cur = newParentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return true; // corrupt data: refuse rather than loop
    seen.add(cur);
    cur = parents.get(cur) ?? null;
  }
  return false;
}

/** Packets are immutable; a revision is always max(version) + 1. */
export function nextPacketVersion(existing: { version: number }[]) {
  return existing.reduce((m, p) => Math.max(m, p.version), 0) + 1;
}

/**
 * Would "item depends on dependsOn" close a loop? True when they're the same
 * item or dependsOn already (transitively) depends on item.
 */
export function wouldCreateDependencyCycle(edges: { itemId: string; dependsOnId: string }[], itemId: string, dependsOnId: string) {
  if (itemId === dependsOnId) return true;
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.itemId, [...(next.get(e.itemId) ?? []), e.dependsOnId]);
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === itemId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}
