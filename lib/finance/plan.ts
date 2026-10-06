/**
 * Long-term obligations & irregular income: plan years, revisions, events,
 * per-fund allocations, Plan / Actual / Forecast and variances. Pure.
 *
 * Sign convention: income is positive (adds to funds), obligations negative
 * (draws on funds), reallocations net to zero across funds.
 *
 * Actuals belong to the event, not the revision, and carry their own stored
 * fund allocations, so switching or promoting revisions never changes what
 * actually happened. Corrections are new audited allocation rows.
 */
import type { Cents } from "./types";

export type PlanEventKind = "income" | "obligation" | "reallocation";
export type PlanMode = "plan" | "actual" | "forecast";

export type PlanEvent = {
  id: string;
  label: string;
  kind: PlanEventKind;
  /** open → partial (some installments) → complete */
  status: "open" | "partial" | "complete";
  /** explicit amount still expected for a partial event (signed); null = estimate minus actuals */
  remainingAmount?: Cents | null;
  imported?: boolean;
};

/** An event's estimate inside one revision. */
export type EventEstimate = {
  eventId: string;
  date: string;
  amount: Cents;
  allocations: Record<string, Cents>;
  /** dropped from this revision (actuals still show) */
  removed?: boolean;
};

export type ActualAllocation = { fundId: string | null; amount: Cents };
export type ActualInstallment = { id: string; eventId: string; date: string; amount: Cents; allocations: ActualAllocation[] };

export type PlanInput = {
  funds: { id: string; name: string }[];
  openings: Record<string, Cents>;
  goals?: Record<string, Cents>;
  events: PlanEvent[];
  estimates: EventEstimate[];
  actuals: ActualInstallment[];
  mode: PlanMode;
};

export type PlanRow = {
  eventId: string;
  label: string;
  kind: PlanEventKind;
  status: PlanEvent["status"];
  date: string;
  amount: Cents;
  allocations: Record<string, Cents>;
  /** amount not assigned to any fund (needs attention when non-zero) */
  unallocated: Cents;
  estimate?: { date: string; amount: Cents };
  actual?: { date: string; amount: Cents };
  variance?: { amount: Cents; days: number };
  /** has actuals but isn't part of this revision */
  notInRevision: boolean;
  imported?: boolean;
  attention: string[];
};

export type PlanResult = {
  rows: PlanRow[];
  openings: Record<string, Cents>;
  change: Record<string, Cents>;
  endings: Record<string, Cents>;
  diffFromGoal: Record<string, Cents | null>;
  totalUnallocated: Cents;
  attention: number;
};

const sum = (o: Record<string, Cents>) => Object.values(o).reduce((s, v) => s + v, 0);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Scale allocations to a new total; rounding remainder goes to the largest share so cents are conserved. */
export function scaleAllocations(allocations: Record<string, Cents>, from: Cents, to: Cents): Record<string, Cents> {
  if (from === 0) return {};
  const entries = Object.entries(allocations);
  const scaled = entries.map(([k, v]) => [k, Math.trunc((v * to) / from)] as const);
  const target = Math.trunc((sum(allocations) * to) / from);
  const diff = target - scaled.reduce((s, [, v]) => s + v, 0);
  const out = Object.fromEntries(scaled);
  if (diff !== 0 && entries.length) {
    const largest = entries.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a))[0];
    out[largest] = (out[largest] ?? 0) + diff;
  }
  return out;
}

function actualTotals(list: ActualInstallment[]) {
  const allocations: Record<string, Cents> = {};
  let amount = 0;
  let explicitUnallocated = 0;
  for (const a of list) {
    amount += a.amount;
    for (const x of a.allocations) {
      if (x.fundId === null) explicitUnallocated += x.amount;
      else allocations[x.fundId] = (allocations[x.fundId] ?? 0) + x.amount;
    }
  }
  return {
    amount,
    allocations,
    explicitUnallocated,
    date: list
      .map((a) => a.date)
      .sort()
      .at(-1)!,
  };
}

export function computePlan(input: PlanInput): PlanResult {
  const est = new Map(input.estimates.map((e) => [e.eventId, e]));
  const actualsBy = new Map<string, ActualInstallment[]>();
  for (const a of input.actuals) actualsBy.set(a.eventId, [...(actualsBy.get(a.eventId) ?? []), a]);

  const rows: PlanRow[] = [];
  for (const ev of input.events) {
    const e = est.get(ev.id);
    const acts = actualsBy.get(ev.id) ?? [];
    const inRevision = Boolean(e && !e.removed);
    if (!inRevision && !acts.length) continue;
    const actual = acts.length ? actualTotals(acts) : undefined;
    const attention: string[] = [];

    let date: string;
    let amount: Cents;
    let allocations: Record<string, Cents>;
    if (input.mode === "plan") {
      if (!inRevision) continue;
      date = e!.date;
      amount = e!.amount;
      allocations = { ...e!.allocations };
    } else if (input.mode === "actual") {
      if (!actual) continue;
      date = actual.date;
      amount = actual.amount;
      allocations = actual.allocations;
    } else if (actual && (ev.status === "complete" || !inRevision)) {
      date = actual.date;
      amount = actual.amount;
      allocations = actual.allocations;
    } else if (actual && inRevision) {
      // Partial: what happened, plus what's still expected on the remaining planned allocations.
      const remaining = ev.remainingAmount ?? (Math.abs(e!.amount) > Math.abs(actual.amount) ? e!.amount - actual.amount : 0);
      const rest = scaleAllocations(e!.allocations, e!.amount, remaining);
      allocations = { ...actual.allocations };
      for (const [k, v] of Object.entries(rest)) allocations[k] = (allocations[k] ?? 0) + v;
      amount = actual.amount + remaining;
      date = remaining !== 0 ? e!.date : actual.date;
    } else {
      date = e!.date;
      amount = e!.amount;
      allocations = { ...e!.allocations };
    }

    const unallocated = amount - sum(allocations);
    if (unallocated !== 0) attention.push(ev.kind === "reallocation" ? "Reallocation doesn't net to zero" : "Not fully allocated to funds");
    if (!inRevision && actual) attention.push("Happened, but not in this revision");
    if (ev.imported) attention.push("Imported, unreconciled");

    rows.push({
      eventId: ev.id,
      label: ev.label,
      kind: ev.kind,
      status: ev.status,
      date,
      amount,
      allocations,
      unallocated,
      estimate: e && !e.removed ? { date: e.date, amount: e.amount } : undefined,
      actual: actual ? { date: actual.date, amount: actual.amount } : undefined,
      variance: actual && e && !e.removed ? { amount: actual.amount - e.amount, days: daysBetween(e.date, actual.date) } : undefined,
      notInRevision: !inRevision,
      imported: ev.imported,
      attention,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));

  const change: Record<string, Cents> = {};
  const endings: Record<string, Cents> = {};
  const diffFromGoal: Record<string, Cents | null> = {};
  for (const f of input.funds) {
    change[f.id] = rows.reduce((s, r) => s + (r.allocations[f.id] ?? 0), 0);
    endings[f.id] = (input.openings[f.id] ?? 0) + change[f.id]!;
    const goal = input.goals?.[f.id];
    diffFromGoal[f.id] = goal === undefined ? null : endings[f.id]! - goal;
  }
  return {
    rows,
    openings: Object.fromEntries(input.funds.map((f) => [f.id, input.openings[f.id] ?? 0])),
    change,
    endings,
    diffFromGoal,
    totalUnallocated: rows.reduce((s, r) => s + r.unallocated, 0),
    attention: rows.filter((r) => r.attention.length).length,
  };
}
