import type { ActionRank, AttentionBucket, AttentionSummary, AttentionTier, NextAction, PriorityReason } from "@/lib/contracts";
import { actionCategory, categoryLabel, MIN_WEIGHT } from "@/lib/attention";
import { addDays, daysBetween, localDate, startOfLocalDay } from "@/lib/time";
import { classifyDue, dedupeActions, rankActions } from "./index";

/**
 * Home's attention budget: a deterministic, explainable selector on top of the
 * base ranking. Pure (no DB) so it is unit tested directly; getHome feeds it
 * the person's snoozes, pins, Daily Compass focus and feedback weights.
 *
 * Tiers, highest first: critical → awaiting_user → pinned → compass →
 * overdue_recent → due_soon → checkin_window → today → overdue_stale →
 * upcoming → someday. Within a tier: feedback weight → due → recently changed → id.
 * Now and Today take only the tiers up to `today`; critical items are never
 * budgeted away, feedback-snoozed, demoted or muted. Explicit acknowledgement
 * is separate and lasts until its expiry.
 */

export type Budget = { now: number; today: number; upcoming: number };
export const BUDGET: Budget = { now: 3, today: 5, upcoming: 3 };
/** dated items further out than this are "someday" (backlog), not Upcoming */
export const UPCOMING_DAYS = 14;
/** at most this many long-overdue items may fill spare room in Today */
export const STALE_OVERDUE_IN_TODAY = 2;

export const TIER_ORDER: AttentionTier[] = [
  "critical",
  "awaiting_user",
  "pinned",
  "compass",
  "overdue_recent",
  "due_soon",
  "checkin_window",
  "today",
  "overdue_stale",
  "upcoming",
  "someday",
];
const ELIGIBLE = new Set(TIER_ORDER.slice(0, TIER_ORDER.indexOf("today") + 1));
/** tiers a "less like this" category weight cannot push out of Now/Today */
const PROTECTED = new Set<AttentionTier>(["critical", "awaiting_user", "pinned", "due_soon"]);

export type AttentionInput = {
  /** scoped to what this person may see; dedupe happens here */
  actions: NextAction[];
  now: Date;
  timezone: string;
  /** action id → hidden until (ISO) */
  snoozed?: Map<string, string>;
  /** Explicit acknowledgements may hide even critical alerts until expiry. */
  acknowledged?: Map<string, string>;
  pinned?: Set<string>;
  /** today's Daily Compass priorities (only when known for today) */
  focus?: string[];
  /** feedback category → weight (MIN_WEIGHT…MAX_WEIGHT) */
  weights?: Record<string, number>;
  /** action ids the person said were ranked wrong (kept out of Now) */
  demoted?: Set<string>;
  budget?: Budget;
};

export type Attention = {
  now: NextAction[];
  today: NextAction[];
  upcoming: NextAction[];
  backlog: NextAction[];
  waiting: NextAction[];
  completed: NextAction[];
  /** every open, unsnoozed overdue action in rank order (for the triage suggestion) */
  overdue: NextAction[];
  totals: AttentionSummary["totals"];
  overBudget: number;
};

// ---------------------------------------------------------------- focus

const STOP = new Set(["the", "and", "for", "with", "about", "from", "into", "onto", "your", "our", "this", "that", "then", "than", "get", "out", "off"]);

function tokens(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** The first focus line whose significant words all appear in the title (exact words, never fuzzy). */
export function matchFocus(title: string, focus: string[]): string | undefined {
  const words = new Set(tokens(title));
  return focus.find((f) => {
    const need = tokens(f);
    return need.length > 0 && need.every((w) => words.has(w));
  });
}

// ---------------------------------------------------------------- helpers

/** Small stable hash for feedback provenance (not security-relevant). */
export function fingerprint(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function actionFingerprint(a: Pick<NextAction, "id" | "dueAt" | "title">) {
  return fingerprint(`${a.id}|${a.dueAt ?? "-"}|${a.title}`);
}

const TIME_BASED: PriorityReason[] = ["overdue", "due_soon", "today", "upcoming"];

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

type Ctx = { now: Date; timezone: string; today: string; endOfToday: Date };

/** Re-derive time-based reasons from the due date, so cached snapshots never lie about "today". */
function currentReason(a: NextAction, ctx: Ctx): PriorityReason {
  if (!a.dueAt || !TIME_BASED.includes(a.priorityReason)) return a.priorityReason;
  if (a.dueIsDate) {
    const d = localDate(new Date(a.dueAt), ctx.timezone);
    return d < ctx.today ? "overdue" : d === ctx.today ? "today" : "upcoming";
  }
  return classifyDue({ dueAt: a.dueAt, now: ctx.now, endOfToday: ctx.endOfToday });
}

function dueWhy(a: NextAction, reason: PriorityReason, ctx: Ctx): string | undefined {
  if (!a.dueAt) return reason === "today" ? "Today" : undefined;
  const days = daysBetween(ctx.today, localDate(new Date(a.dueAt), ctx.timezone));
  if (reason === "overdue") return days === 0 ? "Overdue since earlier today" : days === -1 ? "Due yesterday" : `Overdue ${plural(-days, "day")}`;
  if (reason === "due_soon") return "Due within 4 hours";
  if (reason === "today") return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${plural(days, "day")}`;
}

type Placed = {
  a: NextAction;
  tier: AttentionTier;
  why: string[];
  weight: number;
  sortAt: number;
  updatedAt: number;
  demoted: boolean;
  muted: boolean;
  overdue: boolean;
};

function classify(a: NextAction, ctx: Ctx, input: AttentionInput): Placed {
  const reason = currentReason(a, ctx);
  const pinned = Boolean(a.pinned || input.pinned?.has(a.id));
  const deferred = Boolean(a.availableAt && new Date(a.availableAt) > ctx.now);
  const category = actionCategory(a.source);
  const weight = reason === "critical" ? 0 : (input.weights?.[category] ?? 0);
  const focus = input.focus?.length ? matchFocus(a.title, input.focus) : undefined;
  const due = dueWhy(a, reason, ctx);
  const why: string[] = [];
  let tier: AttentionTier;

  if (reason === "critical") {
    tier = "critical";
    why.push("Safety alert: always shown");
  } else if (deferred) {
    tier = "upcoming";
    why.push("Not available yet");
  } else if (reason === "awaiting_user") {
    tier = "awaiting_user";
    why.push("Waiting on your answer");
  } else if (pinned) {
    tier = "pinned";
    why.push("Pinned by you");
  } else if (focus) {
    tier = "compass";
    why.push(`Matches Daily Compass focus “${focus}”`);
  } else if (reason === "overdue") {
    const late = a.dueAt ? daysBetween(localDate(new Date(a.dueAt), ctx.timezone), ctx.today) : 0;
    tier = late <= 1 ? "overdue_recent" : "overdue_stale";
  } else if (reason === "due_soon" || reason === "checkin_window" || reason === "today") {
    tier = reason;
    if (reason === "checkin_window") why.push("Check-in window is open");
  } else if (!a.dueAt) {
    tier = "someday";
    why.push("No due date");
  } else {
    tier = daysBetween(ctx.today, localDate(new Date(a.dueAt), ctx.timezone)) <= UPCOMING_DAYS ? "upcoming" : "someday";
  }
  if (due && tier !== "critical") why.push(due);

  const demoted = tier !== "critical" && Boolean(input.demoted?.has(a.id));
  const muted = weight <= MIN_WEIGHT && !PROTECTED.has(tier);
  const label = categoryLabel(category);
  if (muted) why.push(`Kept out of Now and Today: you asked for fewer ${label}`);
  else if (weight < 0) why.push(`Shown later: you asked for fewer ${label}`);
  else if (weight > 0) why.push(`Shown earlier: you marked ${label} helpful`);
  if (demoted) why.push("You said this was ranked wrong");

  const at = a.dueAt ?? (deferred ? a.availableAt : undefined);
  return {
    a: { ...a, priorityReason: reason },
    tier,
    why,
    weight,
    sortAt: at ? new Date(at).getTime() : Number.POSITIVE_INFINITY,
    updatedAt: new Date(a.updatedAt).getTime() || 0,
    demoted,
    muted,
    overdue: reason === "overdue",
  };
}

function compare(x: Placed, y: Placed) {
  const t = TIER_ORDER.indexOf(x.tier) - TIER_ORDER.indexOf(y.tier);
  if (t) return t;
  if (x.weight !== y.weight) return y.weight - x.weight;
  if (x.sortAt !== y.sortAt) {
    // Long-overdue: the most recently slipped is the most likely to still matter.
    const asc = x.sortAt < y.sortAt ? -1 : 1;
    return x.tier === "overdue_stale" && Number.isFinite(x.sortAt) && Number.isFinite(y.sortAt) ? -asc : asc;
  }
  if (x.updatedAt !== y.updatedAt) return y.updatedAt - x.updatedAt;
  return x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0;
}

export function selectAttention(input: AttentionInput): Attention {
  const budget = input.budget ?? BUDGET;
  const today = localDate(input.now, input.timezone);
  const ctx: Ctx = { now: input.now, timezone: input.timezone, today, endOfToday: startOfLocalDay(addDays(today, 1), input.timezone) };
  const all = dedupeActions(input.actions).map((a) => (input.pinned?.has(a.id) ? { ...a, pinned: true } : a));

  let snoozedCount = 0;
  const activelySnoozed = (a: NextAction) => {
    const until = input.snoozed?.get(a.id);
    const acknowledgedUntil = input.acknowledged?.get(a.id);
    return (!!until && new Date(until) > input.now) || (!!acknowledgedUntil && new Date(acknowledgedUntil) > input.now);
  };
  const open: Placed[] = [];
  for (const a of all) {
    if (a.status !== "open") continue;
    const until = input.snoozed?.get(a.id);
    const placed = classify(a, ctx, input);
    const acknowledgedUntil = input.acknowledged?.get(a.id);
    if ((acknowledgedUntil && new Date(acknowledgedUntil) > input.now) || (until && new Date(until) > input.now && placed.tier !== "critical")) {
      snoozedCount++;
      continue;
    }
    open.push(placed);
  }
  open.sort(compare);

  const out: Record<AttentionBucket, NextAction[]> = { now: [], today: [], upcoming: [], backlog: [] };
  const overdue: NextAction[] = [];
  let staleInToday = 0;
  const put = (p: Placed, bucket: AttentionBucket, extra?: string) => {
    const rank: ActionRank = { tier: p.tier, bucket, category: actionCategory(p.a.source), fingerprint: actionFingerprint(p.a) };
    const pinned = p.a.pinned || input.pinned?.has(p.a.id) || undefined;
    const placed = { ...p.a, ...(pinned ? { pinned } : {}), why: extra ? [...p.why, extra] : p.why, rank };
    out[bucket].push(placed);
    if (p.overdue) overdue.push(placed);
  };

  for (const p of open) {
    if (p.tier === "critical") put(p, "now");
    else if (p.muted) put(p, "backlog");
    else if (ELIGIBLE.has(p.tier)) {
      if (!p.demoted && out.now.length < budget.now) put(p, "now");
      else if (out.today.length < budget.today) put(p, "today");
      else put(p, "backlog", `Over the Today limit (${budget.today})`);
    } else if (p.tier === "overdue_stale") {
      if (staleInToday < STALE_OVERDUE_IN_TODAY && out.today.length < budget.today) {
        staleInToday++;
        put(p, "today");
      } else put(p, "backlog");
    } else if (p.tier === "upcoming") put(p, "upcoming");
    else put(p, "backlog");
  }

  const critical = open.filter((p) => p.tier === "critical").length;
  const waiting = rankActions(all.filter((a) => a.status === "waiting" && !activelySnoozed(a)));
  return {
    ...out,
    overdue,
    waiting,
    completed: all
      .filter((a) => a.status === "completed" && !activelySnoozed(a))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, 5),
    totals: {
      open: open.length,
      now: out.now.length,
      today: out.today.length,
      upcoming: out.upcoming.length,
      backlog: out.backlog.length,
      overdue: open.filter((p) => p.overdue).length,
      snoozed: snoozedCount,
      waiting: waiting.length,
    },
    overBudget: Math.max(0, critical - budget.now),
  };
}
