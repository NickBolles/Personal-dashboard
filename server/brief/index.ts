import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { userById, type CurrentUser } from "@/server/auth";
import { can } from "@/server/access";
import { HttpError } from "@/server/http/errors";
import { getPreferences } from "@/server/settings";
import { isConfigured } from "@/integrations/store";
import { getAiSettings } from "@/server/ai/settings";
import { errorText } from "@/server/ai/rules";
import { homePulse } from "@/server/home/pulse";
import { addDays, localDate, localMinutes } from "@/lib/time";
import type { JobErrorCode, JobState } from "@/lib/ai";
import {
  BRIEF_BASIS_SOURCES,
  BRIEF_BASIS_SOURCE_LABEL,
  BRIEF_LIMITS,
  isWidgetKind,
  shortHash,
  type BriefBasis,
  type BriefBasisSource,
  type BriefBlockView,
  type BriefBuildState,
  type BriefDoc,
  type BriefOutput,
  type BriefPickDoc,
  type BriefPickView,
  type BriefView,
  type BriefWidgetData,
  type BriefWidgetKind,
  type PickState,
} from "@/lib/brief";
import { briefContext, feedbackRef, noteRef, renderContext, type BriefContext } from "./context";
import { resolveOutput, rulesBrief } from "./compose";
import { briefDeck } from "./deck";
import { improveView } from "./improve";
import {
  feedbackFor,
  getBriefSettings,
  insertBrief,
  latestBrief,
  listAutoBriefUsers,
  listNotes,
  parseDoc,
  parseTicks,
  proposeNotes,
  recordOutcomes,
  tickedSteps,
} from "./store";

/**
 * The daily brief service (docs/brief.md). Reading a brief never calls a model
 * or an upstream: it is the last stored AI build for today, or the rules brief
 * computed from cached Home data. Building is an AI job (`brief`) on the normal
 * runner, so the daily budget, the subscription meter, retries and the spend
 * ledger all apply.
 */

export const BRIEF_CAP = "brief.use";
const J = schema.aiJobs;
type JobRow = typeof J.$inferSelect;

export function aiStatus(): { available: boolean; reason?: string } {
  if (!getAiSettings().enabled) return { available: false, reason: "AI is turned off in Settings → AI." };
  if (!isConfigured("hermes")) return { available: false, reason: "Connect Hermes so Jarvis can write your brief." };
  return { available: true };
}

function jobsFor(userId: string, date: string): JobRow[] {
  return getDb()
    .select()
    .from(J)
    .where(and(eq(J.userId, userId), eq(J.kind, "brief"), eq(J.subjectType, "brief"), eq(J.subjectId, date)))
    .orderBy(desc(J.createdAt))
    .all();
}

/** Builds that count against the daily allowance: anything that ran or may still run. */
const countsAsBuild = (j: JobRow) => !["skipped", "cancelled"].includes(j.state);

function buildState(jobs: JobRow[], briefAt: string | undefined): BriefView["build"] {
  const buildsToday = jobs.filter(countsAsBuild).length;
  const base = { buildsToday, buildsLeft: Math.max(0, BRIEF_LIMITS.buildsPerDay - buildsToday) };
  const j = jobs[0];
  if (!j) return { state: "idle", ...base };
  const state = j.state as JobState;
  const map: Partial<Record<JobState, BriefBuildState>> = {
    queued: "queued",
    running: "building",
    waiting_approval: "building",
    cancelling: "building",
    budget_blocked: "blocked",
  };
  if (map[state]) {
    const message =
      state === "budget_blocked"
        ? j.errorCode === "quota"
          ? (j.errorMessage ?? "Background AI is paused by the usage limit.")
          : "Today's AI budget is used up. The brief will build tomorrow, or build it anyway."
        : undefined;
    return { state: map[state]!, jobId: j.id, ...(message ? { message } : {}), ...base };
  }
  // A failure only matters until a newer brief exists.
  if (state === "failed" && (!briefAt || j.createdAt > briefAt))
    return { state: "failed", jobId: j.id, message: errorText((j.errorCode ?? "upstream") as JobErrorCode), ...base };
  return { state: "idle", ...base };
}

function pickView(p: BriefPickDoc, c: BriefContext, outcomes: Record<string, string> = {}): BriefPickView {
  const action = c.actions.get(p.actionId);
  const state: PickState = action ? "open" : c.completed.has(p.actionId) || outcomes[p.actionId] ? "done" : "gone";
  return { ...p, state, ...(action ? { action, title: action.title } : {}) };
}

function widgetData(kind: BriefWidgetKind, c: BriefContext, user: CurrentUser): BriefWidgetData | null {
  if (kind === "schedule") {
    const events = c.events
      .filter((e) => localDate(new Date(e.startsAt), c.timezone) === c.today)
      .map((e) => ({
        id: e.id,
        title: e.title,
        startsAt: e.startsAt,
        ...(e.endsAt ? { endsAt: e.endsAt } : {}),
        ...(e.allDay ? { allDay: true } : {}),
        ...(e.calendar ? { calendar: e.calendar } : {}),
        ...(!e.allDay && new Date(e.endsAt ?? e.startsAt).getTime() < c.now.getTime() ? { past: true } : {}),
      }));
    return events.length || c.calendarKnown ? { kind, events, known: c.calendarKnown } : null;
  }
  if (kind === "momentum") {
    const trend = homePulse(user, c.now).trend;
    return trend ? { kind, days: trend.days, added: trend.added, completed: trend.completed } : null;
  }
  if (kind === "household") {
    if (!can(user, "home_assistant.view")) return null;
    return {
      kind,
      known: c.householdKnown,
      exceptions: c.exceptions.map((e) => ({
        name: e.name,
        reason: e.reason,
        severity: e.severity,
        href: `/home-control?entity=${encodeURIComponent(e.entityId)}`,
      })),
    };
  }
  if (kind === "dates") return c.dates.length ? { kind, dates: c.dates } : null;
  if (kind === "training") return c.training ? { kind, weeks: c.training.weeks, ...(c.training.last ? { last: c.training.last } : {}) } : null;
  if (!c.compass) return null;
  const y = c.journal.find((j) => j.date === addDays(c.today, -1));
  return {
    kind: "compass",
    ...c.compass,
    focus: c.focus,
    ...(y && (y.summary || y.tomorrow) ? { yesterday: { ...(y.summary ? { summary: y.summary } : {}), ...(y.tomorrow ? { tomorrow: y.tomorrow } : {}) } } : {}),
  };
}

/** Widgets with something to show right now (the model may only place these; the rules brief places all of them). */
function availableWidgets(c: BriefContext, user: CurrentUser) {
  const out = new Map<BriefWidgetKind, BriefWidgetData>();
  for (const k of ["schedule", "compass", "household", "dates", "training", "momentum"] as const) {
    const d = widgetData(k, c, user);
    if (!d) continue;
    // An empty household widget is noise: only show it when there is an exception.
    if (d.kind === "household" && !d.exceptions.length) continue;
    out.set(k, d);
  }
  return out;
}

function blockViews(
  doc: BriefDoc,
  c: BriefContext,
  widgets: Map<BriefWidgetKind, BriefWidgetData>,
  outcomes: Record<string, string>,
  ticks: Record<string, string> = {},
): BriefBlockView[] {
  const out: BriefBlockView[] = [];
  for (const b of doc.blocks) {
    if (isWidgetKind(b.kind)) {
      const widget = widgets.get(b.kind);
      // Data that went away since the build (a cleared exception) takes its widget with it.
      if (widget) out.push({ id: b.id, kind: b.kind, ...(b.text ? { text: b.text } : {}), widget });
      continue;
    }
    const { actions, ...rest } = b;
    const done = b.steps?.length ? tickedSteps(ticks, b.id, b.steps.length) : [];
    out.push({
      ...rest,
      ...(done.length ? { done } : {}),
      ...(actions?.length
        ? {
            actions: actions.map((a) => {
              const p = pickView({ ...a, why: "" }, c, outcomes);
              return { actionId: a.actionId, title: p.title, state: p.state, ...(p.action ? { href: p.action.href } : {}) };
            }),
          }
        : {}),
    });
  }
  return out;
}

/** Safety alerts are never budgeted away (docs/home-priorities.md): any the picks left out are shown regardless. */
function safetyAlerts(c: BriefContext, picked: (BriefPickDoc | null)[]): BriefPickView[] {
  const have = new Set(picked.filter(Boolean).map((p) => p!.actionId));
  return c.nowList
    .filter((a) => a.rank?.tier === "critical" && !have.has(a.id))
    .map((a) => ({ actionId: a.id, title: a.title, why: (a.why ?? [])[0] ?? "", state: "open" as const, action: a }));
}

export async function getBriefView(user: CurrentUser, now = new Date()): Promise<BriefView> {
  const c = await briefContext(user, now);
  const settings = getBriefSettings(user.id);
  const ai = aiStatus();
  const widgets = availableWidgets(c, user);
  // With the AI brief switched off the page is the rules brief, even if something was written earlier today.
  const row = settings.ai ? latestBrief(user.id, c.today) : undefined;
  const jobs = jobsFor(user.id, c.today);

  let brief: BriefView["brief"];
  if (row) {
    const doc = parseDoc(row);
    const picks = [...(doc.first ? [doc.first] : []), ...doc.then];
    const outcomes = recordOutcomes(
      row,
      picks.filter((p) => c.completed.has(p.actionId)).map((p) => p.actionId),
      now,
    );
    brief = {
      id: row.id,
      source: "ai",
      builtAt: row.createdAt,
      model: row.model,
      headline: doc.headline,
      lead: doc.lead,
      first: doc.first ? pickView(doc.first, c, outcomes) : null,
      then: doc.then.map((p) => pickView(p, c, outcomes)),
      alerts: safetyAlerts(c, picks),
      blocks: blockViews(doc, c, widgets, outcomes, parseTicks(row)),
      basedOn: JSON.parse(row.basedOn) as string[],
    };
  } else {
    const doc = rulesBrief({
      today: c.today,
      now: c.nowList,
      later: c.todayList,
      totals: c.totals,
      focus: c.focus,
      hasEvents: widgets.has("schedule"),
      hasCompass: widgets.has("compass"),
      hasDates: widgets.has("dates"),
      hasTrend: widgets.has("momentum"),
      hasExceptions: widgets.has("household"),
      hasTraining: widgets.has("training"),
    });
    brief = {
      id: null,
      source: "rules",
      builtAt: now.toISOString(),
      model: null,
      headline: doc.headline,
      lead: doc.lead,
      first: doc.first ? pickView(doc.first, c) : null,
      then: doc.then.map((p) => pickView(p, c)),
      alerts: safetyAlerts(c, [doc.first, ...doc.then]),
      blocks: blockViews(doc, c, widgets, {}),
      basedOn: ["Home priorities"],
    };
  }

  const notes = listNotes(user.id);
  const day = widgetData("schedule", c, user);
  // The deck holds everything that is not a pick or a safety alert already on the page.
  const onPage = new Set([brief.first, ...brief.then, ...brief.alerts].filter(Boolean).map((p) => p!.actionId));
  const deck = briefDeck(user, c, onPage);
  // A deck card says it once: the widgets it replaces are not repeated among the day's cards.
  const inDeck = new Set(deck.map((d) => d.kind));
  brief.blocks = brief.blocks.filter((b) => !((b.kind === "compass" && inDeck.has("habits")) || (b.kind === "dates" && inDeck.has("ahead"))));
  return {
    date: c.today,
    timezone: c.timezone,
    brief,
    ...(day?.kind === "schedule" ? { day: { events: day.events, known: day.known } } : {}),
    deck,
    improve: improveView(user),
    build: buildState(jobs, row?.createdAt),
    ai: { on: settings.ai, ...ai },
    settings,
    feedback: row ? feedbackFor(user.id, row.id) : [],
    proposals: notes.filter((n) => n.state === "proposed"),
    notes: { active: notes.filter((n) => n.state === "active").length },
  };
}

// ---------------------------------------------------------------- building

/** Queue an AI build of today's brief. Idempotent while one is active; bounded per day. */
export async function startBuild(
  user: CurrentUser,
  input: { clientKey: string; budgetOverride?: boolean; background?: boolean },
  correlationId: string,
  now = new Date(),
) {
  const settings = getBriefSettings(user.id);
  if (!settings.ai) throw new HttpError(409, "brief_ai_off", "Turn on the AI brief first.");
  const ai = aiStatus();
  if (!ai.available) throw new HttpError(409, "ai_unavailable", ai.reason ?? "AI isn't available.");
  const today = localDate(now, getPreferences().timezone);
  const jobs = jobsFor(user.id, today);
  const active = jobs.find((j) => ["queued", "running", "waiting_approval", "cancelling", "budget_blocked"].includes(j.state));
  if (!active && jobs.filter(countsAsBuild).length >= BRIEF_LIMITS.buildsPerDay)
    throw new HttpError(429, "brief_limit", `The brief can be rebuilt ${BRIEF_LIMITS.buildsPerDay} times a day.`);
  const { enqueue, runAnyway } = await import("@/server/ai/jobs");
  const { kickRunner } = await import("@/server/ai/runner");
  // "Build anyway" on a build the budget is holding: release that job (audited) instead of queueing another.
  if (active?.state === "budget_blocked" && input.budgetOverride) {
    const job = runAnyway(user.id, active.id, correlationId);
    kickRunner();
    return { job, created: false };
  }
  const { job, created } = enqueue({
    userId: user.id,
    kind: "brief",
    subjectType: "brief",
    subjectId: today,
    // The job key has no person in it, so the client key carries one.
    clientKey: `${shortHash(user.id)}${input.clientKey}`.slice(0, 64),
    budgetOverride: input.budgetOverride,
    background: input.background,
    correlationId,
  });
  if (created) audit({ actor: user.id, action: "brief.build", source: "ai", sourceRecord: job.id, result: "ok", correlationId, detail: { date: today } });
  kickRunner();
  return { job, created };
}

/**
 * Why a build that was queued must not run, or be stored, any more. A build can wait (in the queue, or on the
 * budget until the next local day), so both are asked again at that moment: the person may have switched the AI
 * brief off since (`ai_disabled`), or the day it was for may be over (`cancelled`).
 */
export function briefJobStale(user: CurrentUser, date: string, now = new Date()): Extract<JobErrorCode, "ai_disabled" | "cancelled"> | null {
  if (!can(user, BRIEF_CAP) || !getBriefSettings(user.id).ai) return "ai_disabled";
  return date === localDate(now, getPreferences().timezone) ? null : "cancelled";
}

/** Switching the AI brief off: builds that have not started are cancelled, and one that is running is asked to stop. */
export async function cancelPendingBuilds(userId: string, correlationId: string) {
  const { requestCancel } = await import("@/server/ai/jobs");
  const pending = getDb()
    .select()
    .from(J)
    .where(and(eq(J.userId, userId), eq(J.kind, "brief"), eq(J.subjectType, "brief")))
    .all()
    .filter((j) => ["queued", "budget_blocked", "running", "waiting_approval"].includes(j.state));
  for (const j of pending) requestCancel(userId, j.id, correlationId);
  return pending.length;
}

/** Runner hook: the run input for a `brief` job, built when the job starts (so it sees current data). */
export async function briefJobInput(user: CurrentUser, now = new Date()) {
  const c = await briefContext(user, now);
  return { title: "Daily brief", input: `Write today's brief from the data below.\n\n${renderContext(c)}` };
}

/**
 * Runner hook: validate and store a finished build. "empty" when the answer had nothing usable. A build that
 * finished after the person switched the AI brief off, or after its day ended (a run across midnight), is not
 * stored: it would sit under a day nobody saw it on and read to the next build as picks that were ignored.
 */
export async function saveBuiltBrief(
  job: Pick<JobRow, "id" | "userId" | "subjectId" | "model">,
  data: BriefOutput,
  now = new Date(),
): Promise<"saved" | "empty" | NonNullable<ReturnType<typeof briefJobStale>>> {
  const user = userById(job.userId);
  if (!user) return "empty";
  const stale = briefJobStale(user, job.subjectId, now);
  if (stale) return stale;
  const c = await briefContext(user, now);
  const basis = new Map<string, BriefBasis>();
  for (const n of c.notes) basis.set(noteRef(n.id), { kind: "note", id: n.id, label: n.text.slice(0, 120) });
  for (const j of c.share.checkins ? c.journal : []) basis.set(`c:${j.date}`, { kind: "checkin", id: j.date, label: `Check-in ${j.date}` });
  for (const f of c.feedback) basis.set(feedbackRef(f.id), { kind: "feedback", id: f.id, label: `Your feedback on ${f.date}` });
  // Whole inputs can be cited only when they were actually sent (or, for memory, allowed).
  const sent: Record<BriefBasisSource, boolean> = {
    workouts: c.share.workouts && Boolean(c.training),
    done: c.share.done && c.finished.length > 0,
    calendar: c.share.calendar && c.events.length + c.weekAhead.length > 0,
    memory: c.share.memory,
  };
  for (const k of BRIEF_BASIS_SOURCES) if (sent[k]) basis.set(`src:${k}`, { kind: "source", id: k, label: BRIEF_BASIS_SOURCE_LABEL[k] });
  const { doc, learned } = resolveOutput(data, { byRef: c.byRef, basis, widgets: new Set(availableWidgets(c, user).keys()) });
  if (!doc.first && !doc.then.length && !doc.blocks.length && !doc.lead) return "empty";
  const row = insertBrief({ userId: user.id, date: job.subjectId, jobId: job.id, model: job.model, doc, basedOn: c.basedOn });
  proposeNotes(user.id, row.id, learned);
  return "saved";
}

// ---------------------------------------------------------------- scheduled build

/**
 * Dispatcher task: for each person who turned the AI brief and "build it for me"
 * on, queue one background build once their build time has passed today. One per
 * day (a build the person started counts), never while AI is off, and stopped by
 * the subscription meter like any background job.
 */
export async function briefAutoTick(now = new Date()) {
  if (!aiStatus().available) return 0;
  const tz = getPreferences().timezone;
  const today = localDate(now, tz);
  const minutes = localMinutes(now, tz);
  let started = 0;
  for (const userId of listAutoBriefUsers()) {
    const s = getBriefSettings(userId);
    const at = Number(s.buildAt.slice(0, 2)) * 60 + Number(s.buildAt.slice(3, 5));
    if (minutes < at) continue;
    if (jobsFor(userId, today).length || latestBrief(userId, today)) continue;
    const user = userById(userId);
    if (!user || !can(user, BRIEF_CAP)) continue;
    try {
      const r = await startBuild(user, { clientKey: `auto${today.replace(/-/g, "")}`, background: true }, `brief-auto:${today}`, now);
      if (r.created) started++;
    } catch {
      /* limits, a guard or a disabled setting: try again next tick */
    }
  }
  return started;
}
