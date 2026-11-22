import "server-only";
import type { NextAction } from "@/lib/contracts";
import type { CurrentUser } from "@/server/auth";
import { can } from "@/server/access";
import { listItems } from "@/server/work/store";
import { listDecisions } from "@/server/work/decisions";
import { sortDecisions } from "@/lib/decisions";
import { decisionHref } from "@/lib/decision-route";
import { STATUS_LABELS, type WorkStatus } from "@/lib/work";
import { addDays, calendarDay } from "@/lib/time";
import { BRIEF_LIMITS, type BriefDeckCard, type BriefDeckRow } from "@/lib/brief";
import { eventDay, type BriefContext } from "./context";
import { assistForAction, assistForItem, assistIndex } from "./assist";

/**
 * The cards under the picks (docs/brief.md): everything that is not one of the
 * top few things, one card per theme, which the page lays out as three rows:
 * Next up (Urgent, Decisions), Initiatives (Habits, In progress) and Coming up
 * (On the calendar, Low priority). Built on read from Jarvis' own data. No model
 * sees or writes any of it, so nothing here is filtered by the share switches:
 * it is the person's own page. The one thing that can leave is a single row the
 * person taps the sparkle on (server/brief/assist.ts), and only rows that may.
 */

const ROWS = BRIEF_LIMITS.deckRows;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * A date-only deadline goes out as its calendar day, like an all-day event. Its instant is the END of that local
 * day, which west of Greenwich is already the next day in UTC, so the instant would show a day late.
 */
const actionRow = (a: NextAction, tz: string): BriefDeckRow => ({
  id: a.id,
  title: a.title,
  ...(a.sourceLabel ? { meta: a.sourceLabel } : {}),
  ...(a.dueAt ? (a.dueIsDate ? { at: calendarDay(a.dueAt, a.dueTimezone ?? tz), allDay: true } : { at: a.dueAt }) : {}),
  href: a.href,
  ...(a.external ? { external: true } : {}),
});

/** One card: the first few rows, then either a page that has the rest (`more`) or the rest itself, to unfold in place. */
const card = (kind: BriefDeckCard["kind"], rows: BriefDeckRow[], more?: string, show: number = ROWS): BriefDeckCard[] => {
  if (!rows.length) return [];
  const extra = more ? [] : rows.slice(show, show + BRIEF_LIMITS.deckExtra);
  return [{ kind, total: rows.length, rows: rows.slice(0, show), ...(more ? { more } : {}), ...(extra.length ? { extra } : {}) }];
};

/** Work that is under way, most active first. */
const ACTIVE: WorkStatus[] = ["in_progress", "in_review", "awaiting_validation", "ready_to_settle", "reopened", "ready", "exploring"];

/** Consecutive days with a finished check-in, ending today or yesterday. */
function checkinStreak(c: BriefContext) {
  const done = new Set(c.journal.filter((j) => j.summary).map((j) => j.date));
  let day = done.has(c.today) ? c.today : addDays(c.today, -1);
  let n = 0;
  while (done.has(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

export function briefDeck(user: CurrentUser, c: BriefContext, picked: Set<string>): BriefDeckCard[] {
  const out: BriefDeckCard[] = [];
  const items = can(user, "work.use") ? listItems(user.id) : [];
  const ax = assistIndex(user, items);
  const withAssist = (a: NextAction): BriefDeckRow => {
    const assist = assistForAction(ax, c, a);
    return { ...actionRow(a, c.timezone), ...(assist ? { assist } : {}) };
  };

  // Urgent: what the person named for today in their check-in (their big rocks), then everything
  // else for now, later today and overdue that is not one of the picks.
  const rocks: BriefDeckRow[] = c.focus.slice(0, 3).map((f, i) => ({ id: `rock-${i}`, title: f, meta: "Big rock", href: "/daily-compass" }));
  const seen = new Set(picked);
  const rest: NextAction[] = [];
  for (const a of [...c.nowList, ...c.todayList, ...c.lists.overdue]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    rest.push(a);
  }
  // "N more" opens the Home bucket the first row that did not fit is in (the page's own default is the backlog).
  const hidden = rest[Math.max(0, BRIEF_LIMITS.urgentRows - rocks.length)]?.rank?.bucket;
  const bucket = hidden === "today" || hidden === "upcoming" || hidden === "backlog" ? hidden : "now";
  out.push(...card("urgent", [...rocks, ...rest.map(withAssist)], `/home/all?bucket=${bucket}`, BRIEF_LIMITS.urgentRows));

  // Decisions waiting on the person.
  if (can(user, "work.use") || can(user, "hermes.chat")) {
    const entries = sortDecisions(listDecisions(user).entries);
    out.push(
      ...card(
        "decisions",
        entries.map((e) => ({ id: e.key, title: e.title, meta: clip(e.question, 90), href: decisionHref(e) })),
        "/decisions",
      ),
    );
  }

  // Habits: the recurring things Jarvis can see (workouts, the daily check-in).
  const habits: BriefDeckRow[] = [];
  if (c.training) {
    const week = c.training.weeks[c.training.weeks.length - 1]?.sessions ?? 0;
    habits.push({
      id: "workouts",
      title: "Workouts",
      meta: [`${week} this week`, c.training.last ? `last: ${c.training.last.title}` : ""].filter(Boolean).join(" · "),
      href: "/workouts",
      ...(c.training.last?.date === c.today ? { done: true } : {}),
    });
  }
  if (c.compass) {
    const streak = checkinStreak(c);
    const state = c.compass.completed ? "Done today" : c.compass.inWindow ? "Open now" : `Opens ${c.compass.windowLabel.split("–")[0]!.trim()}`;
    habits.push({
      id: "checkin",
      title: "Daily check-in",
      meta: [state, streak >= 2 ? `${streak} days running` : ""].filter(Boolean).join(" · "),
      href: "/daily-compass",
      ...(c.compass.completed ? { done: true } : {}),
    });
  }
  out.push(...card("habits", habits));

  // Initiatives under way.
  if (can(user, "work.use")) {
    const live = items
      .filter((i) => (i.kind === "project" || i.kind === "investigation") && !i.archived && !i.completedAt && ACTIVE.includes(i.status))
      .sort((a, b) => ACTIVE.indexOf(a.status) - ACTIVE.indexOf(b.status) || a.sortOrder - b.sortOrder);
    out.push(
      ...card(
        "initiatives",
        live.map((i) => {
          const assist = assistForItem(ax, c, user, i);
          return {
            id: i.id,
            title: i.title,
            meta: clip(i.nextAction || STATUS_LABELS[i.status], 90),
            href: `/areas?item=${encodeURIComponent(i.id)}`,
            ...(assist ? { assist } : {}),
          };
        }),
        "/areas",
      ),
    );
  }

  // Coming up: tomorrow and the rest of the week on the calendar, and saved dates within 30 days. A saved date that
  // falls today leads the card: it is not a calendar event, so nothing else on the page would say it.
  const ahead: (BriefDeckRow & { sort: string })[] = [];
  for (const e of [...c.events, ...c.weekAhead]) {
    const day = eventDay(e, c.timezone);
    if (day <= c.today) continue;
    ahead.push({ id: `ev-${e.id}`, title: e.title, at: e.startsAt, ...(e.allDay ? { allDay: true } : {}), sort: e.startsAt });
  }
  for (const d of c.dates) {
    if (d.inDays < 0) continue;
    const meta = d.inDays === 0 ? "Today" : d.inDays === 1 ? "Tomorrow" : `In ${d.inDays} days`;
    ahead.push({ id: `date-${d.id}`, title: d.title, meta, sort: `${addDays(c.today, d.inDays)}T00:00` });
  }
  ahead.sort((a, b) => a.sort.localeCompare(b.sort));
  out.push(
    ...card(
      "ahead",
      ahead.map(({ sort: _sort, ...row }) => row),
    ),
  );

  // Low priority: the backlog, as ranked.
  const low = c.lists.backlog.filter((a) => !seen.has(a.id));
  const lowCard = card("low", low.map(withAssist), "/home/all?bucket=backlog");
  if (lowCard[0]) lowCard[0].total = Math.max(lowCard[0].total, c.totals.backlog);
  out.push(...lowCard);

  return out;
}
