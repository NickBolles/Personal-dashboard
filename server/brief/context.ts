import "server-only";
import type { CalendarEvent, HomeException, NextAction } from "@/lib/contracts";
import type { CurrentUser } from "@/server/auth";
import { can } from "@/server/access";
import { actionVisible, adapterContext, homeSelection } from "@/server/sources";
import { listMilestones } from "@/server/home-tuning";
import { visibleEvents } from "@/server/smart/data";
import { lookup } from "@/server/smart/store";
import { maskSecrets } from "@/server/ai/rules";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { addDays, localDate, localMinutes } from "@/lib/time";
import { briefRef, shortHash, type BriefBasis, type BriefBlockDoc, type BriefNoteView, type BriefOrigin, type BriefSettings } from "@/lib/brief";
import { listWorkouts } from "@/server/workouts";
import {
  briefDocs,
  getBriefSettings,
  listNotes,
  parseDoc,
  parseOutcomes,
  parseTicks,
  recentBriefs,
  recentFeedback,
  tickedSteps,
  type RecentFeedback,
} from "./store";
import { recentJournal, type JournalEntry } from "./journal";

/**
 * Everything a brief is built from, for one person at one moment: the ranked
 * Home selection (already scoped to what they may see), today's and tomorrow's
 * calendar, the check-in journal, what they taught the brief, and how recent
 * picks turned out. `render()` turns the shared part into the model's input.
 *
 * Never included: Finance (cards and data), work in AI-excluded areas, anything
 * the person switched off under Settings → Brief → Shared with the model, and
 * credential-looking text (masked per line). `events`, `journal`, `focus` and
 * `exceptions` are what the PERSON sees in the widgets; `renderContext` applies
 * the share switches before anything goes to the model.
 *
 * Earlier briefs are quoted back (how picks went, small steps, feedback). Each
 * quote is checked against the rules as they are NOW, not as they were the day
 * it was written: a task from a source since switched off, or work since moved
 * into an AI-excluded area, is left out, and so is anything Jarvis can no
 * longer place.
 */

/**
 * The local day an event is on. An all-day event carries a date ("2026-11-22"), not an instant: read as an
 * instant it is UTC midnight, which west of UTC is the evening before, and the event lands on the wrong day.
 */
export const eventDay = (e: Pick<CalendarEvent, "startsAt" | "allDay">, tz: string) =>
  e.allDay || /^\d{4}-\d{2}-\d{2}$/.test(e.startsAt) ? e.startsAt.slice(0, 10) : localDate(new Date(e.startsAt), tz);

export const CANDIDATE_LIMIT = 40;
const TITLE_MAX = 110;
const CONTEXT_MAX = 12_000;

export type Candidate = { ref: string; action: NextAction; bucket: "now" | "today" | "overdue" | "upcoming" | "waiting" | "backlog" };
export type UpcomingDate = { id: string; title: string; date: string; inDays: number };
export type PickOutcome = { date: string; picks: { title: string; first: boolean; done: boolean }[] };
/** Small steps an earlier brief suggested on a card, and how many the person ticked off. */
export type StepOutcome = { date: string; kind: string; title: string; done: number; total: number };
/** Completed workouts: per week for four weeks (oldest first, the last is this week), each session of the last 28 days, and the 28 days before. */
export type Training = {
  weeks: { start: string; sessions: number }[];
  sessions: { date: string; title: string }[];
  prior: number;
  last?: { date: string; title: string };
};
export type Finished = { date: string; title: string; where: string };

export type BriefContext = {
  userName: string;
  today: string;
  timezone: string;
  now: Date;
  share: BriefSettings["share"];
  /** everything open the person can see (for hydrating a stored brief); the model only gets `candidates` */
  actions: Map<string, NextAction>;
  completed: Map<string, NextAction>;
  /** Home's ranked Now and Later today, in order (the rules brief reads these) */
  nowList: NextAction[];
  todayList: NextAction[];
  /** the other ranked buckets, for the person's own page (the swipe deck); the model only gets `candidates` */
  lists: { overdue: NextAction[]; backlog: NextAction[] };
  candidates: Candidate[];
  byRef: Map<string, NextAction>;
  /** whether one action may go to the AI layer at all: never Finance, never AI-excluded work, never a source switched off */
  sendable: (a: NextAction) => boolean;
  /**
   * whether a reference a stored brief holds may still be shown to this person: the action is in their own
   * (scoped) selection, or it is gone and they may still see the source it came from
   */
  mayShow: (p: { actionId: string } & BriefOrigin) => boolean;
  /** whether this person may still see an input a stored card rested on (their check-ins, workouts, the calendar) */
  mayCite: (x: BriefBasis) => boolean;
  totals: { now: number; today: number; overdue: number; upcoming: number; backlog: number; open: number };
  focus: string[];
  compass?: { completed: boolean; inWindow: boolean; windowLabel: string };
  events: CalendarEvent[];
  /** the five days after tomorrow */
  weekAhead: CalendarEvent[];
  calendarKnown: boolean;
  training?: Training;
  /** what was finished in the last seven days, newest first */
  finished: Finished[];
  exceptions: HomeException[];
  householdKnown: boolean;
  dates: UpcomingDate[];
  journal: JournalEntry[];
  notes: BriefNoteView[];
  feedback: RecentFeedback[];
  outcomes: PickOutcome[];
  stepOutcomes: StepOutcome[];
  /** plain labels of what the model is given */
  basedOn: string[];
};

const SOURCE_SHARE: Partial<Record<NextAction["source"], keyof BriefSettings["share"]>> = {
  todos: "todos",
  work: "work",
  paperclip: "work",
  skylight: "household",
  home_assistant: "household",
  daily_compass: "checkins",
};

/** Days until the next occurrence of a saved date (yearly dates roll to next year). */
function daysUntil(date: string, yearly: boolean, today: string): number | null {
  const day = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  if (!yearly) return date >= today ? Math.round((day(date) - day(today)) / 86_400_000) : null;
  let next = `${today.slice(0, 4)}${date.slice(4)}`;
  if (next < today) next = `${Number(today.slice(0, 4)) + 1}${date.slice(4)}`;
  return Math.round((day(next) - day(today)) / 86_400_000);
}

/** Monday of the week a local date falls in. */
function weekStart(date: string) {
  const back = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -back);
}

function trainingFor(userId: string, today: string): Training | undefined {
  const done = listWorkouts(userId)
    .map((w) => w.session)
    .filter((s) => s.status === "completed" && s.date <= today)
    .map((s) => ({ date: s.date, title: s.title }));
  if (!done.length) return undefined;
  const thisWeek = weekStart(today);
  const weeks = [3, 2, 1, 0].map((i) => {
    const start = addDays(thisWeek, -7 * i);
    const end = addDays(start, 6);
    return { start, sessions: done.filter((s) => s.date >= start && s.date <= end).length };
  });
  const from = addDays(today, -27);
  const sessions = done.filter((s) => s.date >= from).slice(0, 20);
  const prior = done.filter((s) => s.date < from && s.date >= addDays(from, -28)).length;
  return { weeks, sessions, prior, ...(done[0] ? { last: done[0] } : {}) };
}

export async function briefContext(user: CurrentUser, now = new Date()): Promise<BriefContext> {
  const settings = getBriefSettings(user.id);
  const share = settings.share;
  const { payload, attention } = await homeSelection(user, { live: false });
  const ctx = adapterContext(now);
  const tz = ctx.timezone;
  const today = localDate(now, tz);

  const open = [...attention.now, ...attention.today, ...attention.upcoming, ...attention.backlog, ...attention.waiting];
  const actions = new Map(open.map((a) => [a.id, a]));
  const completed = new Map(attention.completed.map((a) => [a.id, a]));

  // What the model may pick from: never Finance, never AI-excluded work, only shared sources.
  const items = can(user, "work.use") ? lookup(user) : null;
  const allowed = (a: Pick<NextAction, "source" | "sourceId">) => {
    if (a.source === "finance") return false;
    const key = SOURCE_SHARE[a.source];
    if (key && !share[key]) return false;
    if (a.source === "work" && items) {
      const id = a.sourceId.slice(a.sourceId.indexOf(":") + 1);
      if ("unavailable" in items.item(`item:${id}`)) return false;
    }
    return true;
  };
  const candidates: Candidate[] = [];
  const byRef = new Map<string, NextAction>();
  const push = (list: NextAction[], bucket: Candidate["bucket"], max: number) => {
    let n = 0;
    for (const a of list) {
      if (n >= max || candidates.length >= CANDIDATE_LIMIT) return;
      const ref = briefRef(a.id);
      if (byRef.has(ref) || !allowed(a)) continue;
      byRef.set(ref, a);
      candidates.push({ ref, action: a, bucket });
      n++;
    }
  };
  push(attention.now, "now", 12);
  push(attention.today, "today", 10);
  push(attention.overdue, "overdue", 8);
  push(attention.upcoming, "upcoming", 8);
  push(attention.waiting, "waiting", 4);
  push(
    attention.backlog.filter((a) => a.pinned),
    "backlog",
    4,
  );

  const tomorrow = addDays(today, 1);
  const calendarAllowed = can(user, "skylight.view") || can(user, "home_assistant.calendar");
  const calendarKnown = payload.sources.some((s) => (s.source === "skylight" || s.source === "home_assistant") && (s.state === "ok" || s.state === "stale"));
  const allEvents = calendarAllowed ? visibleEvents(user, now).sort((a, b) => a.startsAt.localeCompare(b.startsAt)) : [];
  const dayOf = (e: CalendarEvent) => eventDay(e, tz);
  const events = allEvents.filter((e) => dayOf(e) === today || dayOf(e) === tomorrow).slice(0, 24);
  const weekAhead = allEvents.filter((e) => dayOf(e) > tomorrow && dayOf(e) <= addDays(today, 6)).slice(0, 20);

  const training = can(user, "workouts.use") ? trainingFor(user.id, today) : undefined;

  // Finished in the last week: completed cards from the sources, and settled or completed work (never AI-excluded areas).
  const weekAgo = addDays(today, -7);
  const finished: Finished[] = attention.completed
    .filter(allowed)
    .map((a) => ({ date: localDate(new Date(a.updatedAt), tz), title: a.title, where: a.sourceLabel ?? a.source }));
  if (items)
    for (const it of items.items.values()) {
      if (!it.completedAt || it.kind === "area" || it.kind === "conversation" || it.kind === "note") continue;
      if (!share.work || "unavailable" in items.item(`item:${it.id}`)) continue;
      finished.push({ date: localDate(new Date(it.completedAt), tz), title: it.title, where: "Areas" });
    }
  const finishedRecent = finished
    .filter((f) => f.date >= weekAgo && f.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 20);

  const compassAllowed = can(user, "daily_compass.use");
  const focus = compassAllowed && payload.attention?.compass?.state === "focus" ? payload.attention.compass.focus : [];
  const journal = compassAllowed ? recentJournal(today, 14) : [];

  const dates: UpcomingDate[] = listMilestones(user.id)
    .map((m) => ({ id: m.id, title: m.title, date: m.date, inDays: daysUntil(m.date, m.yearly, today) }))
    .filter((m): m is UpcomingDate => m.inDays !== null && m.inDays <= 30)
    .sort((a, b) => a.inDays - b.inDays)
    .slice(0, 6);

  const householdKnown = payload.sources.some((s) => s.source === "home_assistant" && (s.state === "ok" || s.state === "stale"));
  const exceptions = payload.glance.homeExceptions.slice(0, 6);

  // History: a stored reference may be quoted again only if it may go out today. The action as it is
  // now decides (the selection is already scoped to what this person may see); when it is gone, where it
  // came from (kept with the reference) does, starting with whether they may still see that source at all;
  // with neither, no.
  const known = new Map([...attention.completed, ...attention.overdue, ...open].map((a) => [a.id, a]));
  const mayShow = (p: { actionId: string } & BriefOrigin) =>
    known.has(p.actionId) || Boolean(p.source && p.sourceId && actionVisible(user, p.source, p.sourceId));
  const mayQuote = (p: { actionId: string } & BriefOrigin) => {
    const a = known.get(p.actionId);
    if (a) return allowed(a);
    return mayShow(p) && allowed({ source: p.source!, sourceId: p.sourceId! });
  };
  // An input a card rested on, by the same access that decides whether its data is read today. Notes and feedback
  // are the person's own words to the brief, and finished work is made of actions already scoped to them.
  const mayCite = (x: BriefBasis) =>
    x.kind === "checkin"
      ? compassAllowed
      : x.kind === "source" && x.id === "workouts"
        ? can(user, "workouts.use")
        : x.kind === "source" && x.id === "calendar"
          ? calendarAllowed
          : true;
  // A written card: every task it pointed at, and every input it rested on, must still be theirs to see and shared.
  const cardOk = (b: BriefBlockDoc) =>
    (b.actions ?? []).every(mayQuote) &&
    (b.basis ?? []).every(
      (x) => mayCite(x) && (x.kind === "checkin" ? share.checkins : x.kind === "source" ? share[x.id as keyof typeof share] === true : true),
    );

  const earlier = recentBriefs(user.id, today, 7).slice(0, 5);
  const stepOutcomes: StepOutcome[] = earlier.flatMap((row) => {
    const ticks = parseTicks(row);
    return parseDoc(row)
      .blocks.filter((b) => b.steps?.length && cardOk(b))
      .map((b) => ({ date: row.date, kind: b.kind, title: b.title ?? "", done: tickedSteps(ticks, b.id, b.steps!.length).length, total: b.steps!.length }));
  });
  const outcomes: PickOutcome[] = earlier
    .map((row) => {
      const doc = parseDoc(row);
      const done = parseOutcomes(row);
      const picks = [...(doc.first ? [{ ...doc.first, first: true }] : []), ...doc.then.map((p) => ({ ...p, first: false }))].filter(mayQuote);
      return { date: row.date, picks: picks.map((p) => ({ title: p.title, first: p.first, done: Boolean(done[p.actionId]) })) };
    })
    .filter((o) => o.picks.length);

  const notes = listNotes(user.id, ["active"]);
  // Feedback quotes what it was about: the same check, on the pick or card it was given on.
  const said = recentFeedback(user.id, today);
  const docs = briefDocs(user.id, [...new Set(said.map((f) => f.briefId))]);
  const feedback = said.flatMap((f): RecentFeedback[] => {
    const doc = docs.get(f.briefId);
    if (!doc) return [];
    const picks = [doc.first, ...doc.then].filter((p) => p !== null);
    // On the brief as a whole: the verdict and their note stay; the headline is quoted only if every pick it could name still may be.
    if (f.targetKey === "brief") return [picks.every(mayQuote) ? f : { ...f, excerpt: "" }];
    if (f.targetKey.startsWith("pick:")) {
      const pick = picks.find((p) => p.actionId === f.targetKey.slice(5));
      return pick && mayQuote(pick) ? [f] : [];
    }
    const card = doc.blocks.find((b) => `block:${b.id}` === f.targetKey);
    return card && cardOk(card) ? [f] : [];
  });

  const basedOn: string[] = [];
  const sources = new Set(candidates.map((c) => c.action.source));
  if (sources.has("todos")) basedOn.push("Todos");
  if (sources.has("work")) basedOn.push("Areas");
  if (sources.has("paperclip")) basedOn.push("Initiatives");
  if (sources.has("hermes")) basedOn.push("Things waiting on you");
  if (sources.has("skylight") || (share.household && exceptions.length)) basedOn.push("Household");
  if (share.calendar && (events.length || weekAhead.length)) basedOn.push("Calendar");
  if (share.workouts && training) basedOn.push("Workouts");
  if (share.done && finishedRecent.length) basedOn.push("Finished work");
  if (share.checkins && (journal.length || focus.length)) basedOn.push(journal.length > 1 ? `${journal.length} check-ins` : "Daily Compass");
  if (notes.length) basedOn.push(notes.length === 1 ? "1 note" : `${notes.length} notes`);
  if (feedback.length) basedOn.push("Your feedback");
  if (dates.length) basedOn.push("Saved dates");
  if (share.memory) basedOn.push("Hermes memory");

  const c = payload.glance.compass;
  return {
    userName: user.name,
    today,
    timezone: tz,
    now,
    share,
    actions,
    completed,
    nowList: attention.now,
    todayList: attention.today,
    lists: { overdue: attention.overdue, backlog: attention.backlog },
    candidates,
    byRef,
    sendable: allowed,
    mayShow,
    mayCite,
    totals: {
      now: attention.totals.now,
      today: attention.totals.today,
      overdue: attention.totals.overdue,
      upcoming: attention.totals.upcoming,
      backlog: attention.totals.backlog,
      open: attention.totals.open,
    },
    focus,
    ...(c && can(user, "daily_compass.use") ? { compass: { completed: c.completed, inWindow: c.inWindow, windowLabel: c.windowLabel } } : {}),
    events,
    weekAhead,
    calendarKnown,
    ...(training ? { training } : {}),
    finished: finishedRecent,
    exceptions,
    householdKnown,
    dates,
    journal,
    notes,
    feedback,
    outcomes,
    stepOutcomes,
    basedOn,
  };
}

// ---------------------------------------------------------------- rendering for the model

/** One line of untrusted text: no newlines or column separators, credentials and account numbers masked, bounded. */
export function line(text: string | undefined, max = TITLE_MAX) {
  const flat = (text ?? "")
    .replace(/[\r\n|<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return maskAccountNumbers(maskSecrets(flat).text).slice(0, max);
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function when(a: NextAction, today: string, tz: string) {
  if (!a.dueAt) return "no date";
  const at = new Date(a.dueAt);
  const d = localDate(at, tz);
  const day = d === today ? "today" : d === addDays(today, 1) ? "tomorrow" : d === addDays(today, -1) ? "yesterday" : d;
  return a.dueIsDate ? `due ${day}` : `due ${day} ${hhmm(localMinutes(at, tz))}`;
}

function block(source: string, rows: string[]) {
  return rows.length ? `<data source="${source}">\n${rows.join("\n")}\n</data>` : "";
}

export const noteRef = (id: string) => `n:${shortHash(id)}`;
export const feedbackRef = (id: string) => `f:${shortHash(id)}`;

/** The run input: the task facts first, then every untrusted section inside its own <data> block. */
export function renderContext(c: BriefContext): string {
  const tz = c.timezone;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(c.now);
  const head = [
    `Today is ${weekday} ${c.today}, ${hhmm(localMinutes(c.now, tz))} local (${tz}). The brief is for ${line(c.userName, 60) || "the owner"}.`,
    `Open right now: ${c.totals.open} (${c.totals.overdue} overdue, ${c.totals.now} in Now, ${c.totals.today} later today, ${c.totals.upcoming} in the next two weeks, ${c.totals.backlog} in the backlog).`,
    c.share.checkins && c.focus.length ? `Today's Daily Compass focus: ${c.focus.map((f) => `"${line(f, 120)}"`).join(", ")}.` : "",
    c.share.memory
      ? "Memory: allowed. You may also draw on what you already remember about this person from earlier conversations and check-ins. Cite it as src:memory."
      : "Memory: not allowed. Use only the data below.",
  ].filter(Boolean);
  const training = c.share.workouts ? c.training : undefined;

  const sections = [
    block(
      "things you may pick: ref | bucket | where | title | due | why Atlas ranks it there",
      c.candidates.map(
        ({ ref, action: a, bucket }) =>
          `${ref} | ${bucket} | ${line(a.sourceLabel ?? a.source, 40)} | ${line(a.title)} | ${when(a, c.today, tz)} | ${line((a.why ?? []).join("; "), 140) || "-"}`,
      ),
    ),
    block(
      "calendar today and tomorrow (cite as src:calendar): day | time | title",
      (c.share.calendar ? c.events : []).map((e) => {
        const at = new Date(e.startsAt);
        const day = eventDay(e, tz) === c.today ? "today" : "tomorrow";
        const time = e.allDay ? "all day" : `${hhmm(localMinutes(at, tz))}${e.endsAt ? `-${hhmm(localMinutes(new Date(e.endsAt), tz))}` : ""}`;
        return `${day} | ${time} | ${line(e.title, 80)}`;
      }),
    ),
    block(
      "daily check-ins, newest first: id | summary | priorities that day | named for the next day",
      (c.share.checkins ? c.journal : []).map(
        (j) => `c:${j.date} | ${line(j.summary, 500) || "-"} | ${j.priorities.map((p) => line(p, 120)).join("; ") || "-"} | ${line(j.tomorrow, 200) || "-"}`,
      ),
    ),
    block(
      "what you know about this person (notes they kept): id | kind | note",
      c.notes.map((n) => `${noteRef(n.id)} | ${n.kind} | ${line(n.text, 200)}`),
    ),
    block(
      "their feedback on recent briefs, newest first: id | date | verdict | what it was about | their note",
      c.feedback.map(
        (f) =>
          `${feedbackRef(f.id)} | ${f.date} | ${f.verdict === "up" ? "right call" : "wrong call"} | ${f.kind}${f.excerpt ? `: ${line(f.excerpt, 140)}` : ""} | ${line(f.note, 300) || "-"}`,
      ),
    ),
    block(
      "what happened to recent picks: date | pick | done that day?",
      c.outcomes.flatMap((o) => o.picks.map((p) => `${o.date} | ${p.first ? "first" : "then"}: ${line(p.title)} | ${p.done ? "done" : "not done"}`)),
    ),
    block(
      "small things earlier briefs suggested, and how many they ticked off: date | card | done of total",
      c.stepOutcomes.map((o) => `${o.date} | ${o.kind}: ${line(o.title, 80)} | ${o.done} of ${o.total}`),
    ),
    block(
      "finished in the last seven days (cite as src:done): date | where | title",
      (c.share.done ? c.finished : []).map((f) => `${f.date} | ${line(f.where, 40)} | ${line(f.title)}`),
    ),
    block(
      "completed workouts (cite as src:workouts): week starting | sessions, then each of the last 28 days",
      training
        ? [
            ...training.weeks.map((w) => `week of ${w.start} | ${w.sessions}`),
            `the 28 days before that | ${training.prior}`,
            ...training.sessions.map((s) => `${s.date} | ${line(s.title, 80)}`),
          ]
        : [],
    ),
    block(
      "calendar for the rest of the week (cite as src:calendar): date | time | title",
      (c.share.calendar ? c.weekAhead : []).map((e) => {
        const at = new Date(e.startsAt);
        const time = e.allDay ? "all day" : hhmm(localMinutes(at, tz));
        return `${eventDay(e, tz)} | ${time} | ${line(e.title, 80)}`;
      }),
    ),
    block(
      "household exceptions: severity | what",
      (c.share.household ? c.exceptions : []).map((e) => `${e.severity} | ${line(`${e.name}: ${e.reason}`, 120)}`),
    ),
    block(
      "saved dates coming up: in days | what",
      c.dates.map((d) => `${d.inDays} | ${line(d.title, 80)}`),
    ),
  ].filter(Boolean);

  // Drop whole trailing sections rather than cut one mid-line; candidates always stay.
  let text = [...head, ...sections].join("\n\n");
  while (text.length > CONTEXT_MAX && sections.length > 1) {
    sections.pop();
    text = [...head, ...sections].join("\n\n");
  }
  return text.slice(0, CONTEXT_MAX);
}
