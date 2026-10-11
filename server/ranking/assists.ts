import { SOURCE_LABELS, type AssistCard, type CalendarEvent, type NextAction } from "@/lib/contracts";
import { ATTENTION_VERSION, MIN_WEIGHT } from "@/lib/attention";
import { DAY, daysBetween, localDate } from "@/lib/time";
import { fingerprint } from "./attention";

/**
 * Suggestion cards for Home, built only from what Jarvis already knows: real
 * overdue counts, dates the person saved, birthday/anniversary events on a
 * calendar they can see, and one dated season. Nothing here calls a model or
 * invents a person, date or fact. Pure, so it is unit tested directly.
 */

export const ASSIST_LIMIT = 2;
export const TRIAGE_MIN = 3;
export const NOT_HELPFUL_DAYS = 14;
export const CONTEXT_MAX = 1500;
/** Christmas gift planning shows from Nov 1 through Dec 20 (local). */
const CHRISTMAS = { from: "11-01", until: "12-20" };
const CALENDAR_MILESTONE = /\b(birthday|bday|anniversary)\b/i;

export type Milestone = { id: string; title: string; date: string; yearly: boolean; leadDays: number };
export type MutedCard = { id: string; fingerprint: string; verdict: "not_helpful" | "wrong_assumption"; createdAt: string };

export type AssistInput = {
  now: Date;
  timezone: string;
  /** open overdue actions this person can see (never critical) */
  overdue: NextAction[];
  /** calendar events this person can see */
  events: CalendarEvent[];
  /** this person's own saved dates */
  milestones: Milestone[];
  canChat: boolean;
  /** may reschedule todos (todos.edit) */
  canReschedule: boolean;
  snoozed?: Map<string, string>;
  muted?: MutedCard[];
  weights?: Record<string, number>;
};

/** Next date (YYYY-MM-DD) on or after `today`; yearly Feb 29 falls back to Feb 28. */
export function nextOccurrence(m: Pick<Milestone, "date" | "yearly">, today: string): string | undefined {
  if (!m.yearly) return m.date >= today ? m.date : undefined;
  const md = m.date.slice(5);
  const on = (year: number) => {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return `${year}-${md === "02-29" && !leap ? "02-28" : md}`;
  };
  const year = Number(today.slice(0, 4));
  return on(year) >= today ? on(year) : on(year + 1);
}

function inWords(days: number) {
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  if (days < 63) return `in ${Math.floor(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

function fmtDay(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function trim(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

type Draft = Omit<AssistCard, "provenance" | "chat"> & { fp: string; sources: string[]; chat?: AssistCard["chat"]; order: number };

function overdueTriage(input: AssistInput, today: string): Draft | undefined {
  // Finance never goes to the AI layer and isn't a task list (docs/finance.md).
  const list = input.overdue.filter((a) => a.source !== "finance" && a.dueAt);
  if (list.length < TRIAGE_MIN) return undefined;
  const dueDate = (a: NextAction) => localDate(new Date(a.dueAt!), input.timezone);
  const sorted = [...list].sort((a, b) => (a.dueAt! < b.dueAt! ? 1 : a.dueAt! > b.dueAt! ? -1 : a.id < b.id ? -1 : 1));
  const n = list.length;
  const weekLate = list.filter((a) => daysBetween(dueDate(a), today) > 7).length;
  const sources = [...new Set(list.map((a) => a.source))].sort();
  const labels = sources.map((s) => SOURCE_LABELS[s]).join(" and ");
  const reschedulable = input.canReschedule
    ? sorted.filter((a) => a.source === "todos" && (a.secondaryActions?.includes("snooze") || a.primaryAction?.kind === "snooze")).slice(0, 50)
    : [];

  let chat: AssistCard["chat"];
  if (input.canChat) {
    const head = `Overdue tasks Jarvis can see (${n} total, most recently due first):`;
    const lines: string[] = [];
    let len = head.length;
    for (const a of sorted) {
      const line = `- ${trim(a.title, 100)} (due ${dueDate(a)}) [${a.source}:${trim(a.sourceId, 60)}]`;
      if (len + line.length + 40 > CONTEXT_MAX) break;
      lines.push(line);
      len += line.length + 1;
    }
    const more = n - lines.length;
    chat = {
      label: "Help me triage",
      draft:
        "Help me triage my overdue tasks. This is read-only planning: don’t complete, reschedule or delete anything. For each one, suggest do it this week, reschedule (with a date) or drop, and I’ll make the changes in Jarvis myself.",
      context: [head, ...lines, ...(more > 0 ? [`…and ${more} more`] : [])].join("\n"),
    };
  }
  const bucket = n <= 5 ? "3-5" : n <= 10 ? "6-10" : n <= 20 ? "11-20" : "21+";
  return {
    id: "assist:overdue_triage",
    kind: "overdue_triage",
    category: "assist:overdue_triage",
    title: n >= 6 ? "Overdue tasks are piling up" : "A few tasks are overdue",
    body: `${n} overdue ${n === 1 ? "task" : "tasks"}${weekLate ? `, ${weekLate} of them more than a week late` : ""}. Want help deciding what to do now, reschedule or drop?`,
    basis: `Counted from your ${labels}`,
    origin: "data",
    tone: "warn",
    why: [`${n} overdue in ${labels}`, `Shown when ${TRIAGE_MIN} or more tasks are overdue`],
    triage: reschedulable.length
      ? { actionIds: reschedulable.map((a) => a.id), items: reschedulable.map((a) => ({ id: a.id, title: trim(a.title, 120), due: dueDate(a) })) }
      : undefined,
    chat,
    fp: `overdue:${bucket}`,
    sources,
    order: 0,
  };
}

function planChat(input: AssistInput, title: string, date: string, days: number, context: string): AssistCard["chat"] {
  if (!input.canChat) return undefined;
  return {
    label: "Brainstorm ideas",
    draft: `Help me plan ahead for ${title} on ${fmtDay(date)} (${days} days away). Brainstorm a few ideas and a simple timeline. Read-only: don’t create events, todos or purchases; I’ll decide.`,
    context,
  };
}

function milestonePlans(input: AssistInput, today: string): Draft[] {
  const out: Draft[] = [];
  for (const m of input.milestones) {
    const occ = nextOccurrence(m, today);
    if (!occ) continue;
    const days = daysBetween(today, occ);
    if (days < 1 || days > m.leadDays) continue;
    out.push({
      id: `assist:plan:${m.id}:${occ}`,
      kind: "plan_ahead",
      category: "assist:plan_ahead",
      title: `${m.title} ${inWords(days)}`,
      body: `${fmtDay(occ)}. Want to brainstorm ideas or make a simple plan?`,
      basis: "From a date you saved in Home priorities",
      origin: "milestone",
      tone: "accent",
      why: [`You saved ${fmtDay(occ)}${m.yearly ? " (every year)" : ""}`, `Shown up to ${m.leadDays} days ahead`],
      chat: planChat(input, m.title, occ, days, `Saved date in Jarvis: ${m.title}, ${occ}${m.yearly ? " (yearly)" : ""}.`),
      fp: `${m.id}:${occ}`,
      sources: ["milestones"],
      order: 1 + days / 1000,
    });
  }
  return out;
}

function calendarPlans(input: AssistInput, today: string): Draft[] {
  const seen = new Set<string>();
  const out: Draft[] = [];
  for (const e of input.events) {
    if (!CALENDAR_MILESTONE.test(e.title)) continue;
    const date = e.allDay ? e.startsAt.slice(0, 10) : localDate(new Date(e.startsAt), input.timezone);
    const days = daysBetween(today, date);
    const dedupe = `${e.title.toLowerCase()}|${date}`;
    if (days < 2 || seen.has(dedupe)) continue;
    seen.add(dedupe);
    const fp = fingerprint(`${e.source}:${e.id}:${date}`);
    const title = trim(e.title, 80);
    out.push({
      id: `assist:plan:event:${fp}`,
      kind: "plan_ahead",
      category: "assist:plan_ahead",
      title: `${title} ${inWords(days)}`,
      body: `${fmtDay(date)}. Want to brainstorm ideas or make a simple plan?`,
      basis: `From your ${SOURCE_LABELS[e.source]} calendar`,
      origin: "calendar",
      tone: "accent",
      why: [`On your ${SOURCE_LABELS[e.source]} calendar for ${fmtDay(date)}`],
      chat: planChat(input, title, date, days, `Calendar event (${SOURCE_LABELS[e.source]}): ${title}, ${date}.`),
      fp,
      sources: [e.source],
      order: 1 + days / 1000,
    });
  }
  return out;
}

function seasonal(input: AssistInput, today: string): Draft | undefined {
  const md = today.slice(5);
  if (md < CHRISTMAS.from || md > CHRISTMAS.until) return undefined;
  const year = today.slice(0, 4);
  const days = daysBetween(today, `${year}-12-25`);
  return {
    id: `assist:seasonal:christmas:${year}`,
    kind: "seasonal",
    category: "assist:seasonal",
    title: "Christmas gifts",
    body: `Christmas is ${inWords(days)}. Want to start a gift list or brainstorm ideas?`,
    basis: "Seasonal idea, not from your calendar",
    origin: "seasonal",
    tone: "neutral",
    why: [`Shown ${CHRISTMAS.from.replace("-", "/")}–${CHRISTMAS.until.replace("-", "/")} each year`, "Turn off with “Less like this”"],
    chat: input.canChat
      ? {
          label: "Brainstorm ideas",
          draft:
            "Help me plan Christmas gifts. Ask me who I’m buying for and a rough budget before suggesting ideas. Read-only: don’t buy, order or add anything.",
          context: `Today is ${today}; Christmas is ${days} days away.`,
        }
      : undefined,
    fp: `christmas:${year}`,
    sources: ["seasonal"],
    order: 2,
  };
}

export function buildAssists(input: AssistInput): AssistCard[] {
  const today = localDate(input.now, input.timezone);
  const drafts = [overdueTriage(input, today), ...milestonePlans(input, today), ...calendarPlans(input, today), seasonal(input, today)].filter(
    (d): d is Draft => Boolean(d),
  );
  const nowMs = input.now.getTime();
  const weight = (c: string) => input.weights?.[c] ?? 0;
  const muted = (d: Draft) =>
    (input.muted ?? []).some(
      (m) => m.id === d.id && (m.verdict === "wrong_assumption" ? m.fingerprint === d.fp : nowMs - new Date(m.createdAt).getTime() < NOT_HELPFUL_DAYS * DAY),
    );
  return drafts
    .filter((d) => {
      const until = input.snoozed?.get(d.id);
      if (until && new Date(until).getTime() > nowMs) return false;
      return weight(d.category) > MIN_WEIGHT && !muted(d);
    })
    .sort((a, b) => weight(b.category) - weight(a.category) || a.order - b.order || (a.id < b.id ? -1 : 1))
    .slice(0, ASSIST_LIMIT)
    .map((d) => {
      const { fp, sources, order, ...card } = d;
      void order;
      return { ...card, provenance: { version: ATTENTION_VERSION, fingerprint: fp, sources, generatedAt: input.now.toISOString() } };
    });
}
