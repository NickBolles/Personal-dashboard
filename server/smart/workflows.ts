import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { adapterContext, cachedSource, scopeResult } from "@/server/sources";
import { addDays, localDate, localMinutes } from "@/lib/time";
import { CATALOG_ID, LIMITS, PR_REF, type JarvisSpec, type UIElement } from "@/lib/jarvis-ui/catalog";
import { DAY_END, planWeekOf, weekDays } from "@/lib/jarvis-ui/intents";
import { calendarRef, canonicalJson, validateSpec } from "@/lib/jarvis-ui/validator";
import type { WorkflowKind, WorkflowResponse } from "@/lib/jarvis-ui/types";
import type { NextAction } from "@/lib/contracts";
import { calendarWeek, openItems } from "./data";
import { sha256 } from "./store";

/**
 * Jarvis-built workflow surfaces (spec §12a #2, #4, #5): the morning brief,
 * the week plan and PR cards. The spec is built from Jarvis data with no
 * model call, stored as a `ui_surfaces` row (origin `workflow`), and then
 * works exactly like a smart reply: refs hydrate live, taps stage intents,
 * Apply writes them with readback, undo reverts. The same components can
 * come from Hermes in chat (context refs below give it the refs).
 */

const T = schema.uiSurfaces;
const BRIEF_ROWS = 8;
const WEEK_BLOCKS = 24;

type Candidate = { ref: string; title: string; due?: string; minutes: number; reason?: string };

function openTodos(user: CurrentUser, now: Date): NextAction[] {
  if (!can(user, "todos.view")) return [];
  return (scopeResult(user, cachedSource("todos", now))?.data?.actions ?? []).filter((a) => a.status === "open");
}

function todoDue(a: NextAction, tz: string) {
  return a.dueAt ? localDate(new Date(a.dueAt), tz) : undefined;
}

/** Todos + work items due by `until` (overdue included), soonest-late first. */
function candidates(user: CurrentUser, until: string, now: Date, opts: { undated?: boolean } = {}): Candidate[] {
  const tz = adapterContext(now).timezone;
  const todos: Candidate[] = openTodos(user, now)
    .map((a) => ({ ref: `todo:${a.sourceId}`, title: a.title, due: todoDue(a, tz), minutes: 30 }))
    .filter((c) => c.due && c.due <= until);
  const { items } = openItems(user);
  const dated: Candidate[] = items
    .filter((i) => i.targetDate && i.targetDate <= until)
    .map((i) => ({
      ref: `item:${i.id}`,
      title: i.title,
      due: i.targetDate!,
      minutes: 90,
      reason: i.nextAction ? `Next: ${i.nextAction}`.slice(0, 300) : undefined,
    }));
  const undated: Candidate[] = opts.undated
    ? items
        .filter((i) => !i.targetDate && i.status === "in_progress")
        .map((i) => ({ ref: `item:${i.id}`, title: i.title, minutes: 90, reason: i.nextAction ? `Next: ${i.nextAction}`.slice(0, 300) : undefined }))
    : [];
  return [...todos, ...dated].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : a.ref < b.ref ? -1 : 1)).concat(undated);
}

function el(type: UIElement["type"], props: Record<string, unknown>, children?: string[]): UIElement {
  return children ? { type, props, children } : { type, props };
}

function spec(elements: Record<string, UIElement>): JarvisSpec {
  const v = validateSpec({ v: 1, catalog: CATALOG_ID, root: "r", elements });
  if (!v.ok || v.dropped) throw new HttpError(500, "workflow_invalid", "Couldn't build that view");
  return v.spec;
}

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function buildBrief(user: CurrentUser, now = new Date()): JarvisSpec {
  const today = localDate(now, adapterContext(now).timezone);
  // Due today first, then the most recently missed: today's real candidates.
  const rows = candidates(user, today, now)
    .sort((a, b) => (a.due! > b.due! ? -1 : a.due! < b.due! ? 1 : 0))
    .slice(0, BRIEF_ROWS)
    .map((c) => ({ ref: c.ref, ...(c.reason ? { reason: c.reason } : {}) }));
  const elements: Record<string, UIElement> = {};
  const kids: string[] = [];
  const numbers: string[] = [];
  if (can(user, "work.ai")) {
    elements.g1 = el("Gauge", { metric: "metric:ai_spend_today" });
    elements.s1 = el("Sparkline", { metric: "metric:ai_spend_7d" });
    numbers.push("g1", "s1");
  }
  if (can(user, "work.use")) {
    elements.s2 = el("Sparkline", { metric: "metric:items_done_14d" });
    numbers.push("s2");
  }
  if (numbers.length) {
    elements.n = el("Stack", { direction: "row", gap: "sm" }, numbers);
    kids.push("n");
  }
  if (rows.length) elements.c = el("ApprovalChips", { title: "Worth doing today", rows });
  else elements.c = el("Callout", { tone: "ok", title: "Nothing is due today", text: "No todos or work items are due or overdue." });
  kids.push("c");
  elements.r = el("Stack", {}, kids);
  return spec(elements);
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const WORK_START = toMin("09:00");
const WORK_END = toMin("17:00");

/**
 * A first-pass week: each todo/item due this week (or overdue) gets a block on
 * its due day (overdue → the first plannable day), packed into 09:00–17:00
 * around the fixed calendar events; what doesn't fit is left unscheduled.
 */
export function buildWeek(user: CurrentUser, now = new Date()): JarvisSpec {
  const tz = adapterContext(now).timezone;
  const today = localDate(now, tz);
  // Never place a block in the past: today starts at the next quarter hour.
  const todayStart = Math.max(WORK_START, Math.ceil(localMinutes(now, tz) / 15) * 15);
  const weekOf = planWeekOf(today);
  const all = weekDays(weekOf, 5);
  const days = all.filter((d) => d >= today);
  const cal = calendarWeek(user, calendarRef(weekOf, 5), now);
  const busy = new Map<string, [number, number][]>(days.map((d) => [d, []]));
  if ("events" in cal)
    for (const e of cal.events)
      if (!e.allDay && e.start && busy.has(e.day))
        busy.get(e.day)!.push([toMin(e.start), e.end ? Math.max(toMin(e.end), toMin(e.start) + 15) : toMin(e.start) + 60]);
  const place = (from: string, minutes: number) => {
    for (const d of days.filter((x) => x >= from)) {
      const taken = busy.get(d)!.sort((a, b) => a[0] - b[0]);
      let t = d === today ? todayStart : WORK_START;
      for (const [s, e] of taken) {
        if (t + minutes <= s) break;
        t = Math.max(t, Math.ceil(e / 15) * 15);
      }
      if (t + minutes <= Math.min(WORK_END, toMin(DAY_END))) {
        taken.push([t, t + minutes]);
        return { day: d, start: toHHMM(t) };
      }
    }
    return null;
  };
  const blocks = candidates(user, all[all.length - 1]!, now, { undated: true })
    .slice(0, WEEK_BLOCKS)
    .map((c) => {
      const spot = days.length && c.due ? place(c.due < days[0]! ? days[0]! : c.due, c.minutes) : null;
      return spot ? { ref: c.ref, day: spot.day, start: spot.start, minutes: c.minutes } : { ref: c.ref, day: null, minutes: c.minutes };
    });
  const elements: Record<string, UIElement> = {};
  if (blocks.length) elements.r = el("WeekPlan", { title: `Week of ${fmtDay(weekOf)}`, weekOf, days: 5, blocks });
  else elements.r = el("Callout", { tone: "ok", title: "Nothing to plan this week", text: "No todos or work items are due this week." });
  return spec(elements);
}

export function buildPr(ref: string): JarvisSpec {
  if (!PR_REF.test(ref)) throw new HttpError(400, "invalid_ref", "That isn't a pull request");
  return spec({ r: el("PRCard", { ref }) });
}

function keyFor(kind: WorkflowKind, user: CurrentUser, ref: string | undefined, now: Date) {
  const today = localDate(now, adapterContext(now).timezone);
  if (kind === "brief") return today;
  if (kind === "week") return planWeekOf(today);
  if (!ref || !PR_REF.test(ref)) throw new HttpError(400, "invalid_ref", "That isn't a pull request");
  return ref.toLowerCase();
}

/**
 * The person's current workflow surface: the stored one for today / this week
 * / this PR, so applied rows survive reloads and other devices; `rebuild`
 * builds a fresh one from current data (a new surface; the old one keeps its history).
 */
export function workflowSurface(user: CurrentUser, input: { kind: WorkflowKind; ref?: string; rebuild?: boolean }, now = new Date()): WorkflowResponse {
  const sessionId = `workflow:${input.kind}:${keyFor(input.kind, user, input.ref, now)}`;
  const db = getDb();
  if (!input.rebuild) {
    const row = db
      .select()
      .from(T)
      .where(and(eq(T.userId, user.id), eq(T.sessionId, sessionId)))
      .orderBy(desc(T.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
    if (row) return { kind: input.kind, sessionId, blockIndex: row.blockIndex, spec: JSON.parse(row.specJson) as JarvisSpec, builtAt: row.createdAt };
  }
  const built = input.kind === "brief" ? buildBrief(user, now) : input.kind === "week" ? buildWeek(user, now) : buildPr(input.ref!);
  const specJson = canonicalJson(built);
  if (specJson.length > LIMITS.blockBytes) throw new HttpError(500, "too_large", "That view is too large");
  const specHash = sha256(specJson);
  db.insert(T)
    .values({
      id: `uis_${newId().replace(/-/g, "").slice(0, 24)}`,
      userId: user.id,
      origin: "workflow",
      sessionId,
      messageKey: specHash,
      blockIndex: 0,
      catalog: CATALOG_ID,
      specHash,
      specJson,
      createdAt: new Date().toISOString(),
    })
    // Rebuilding unchanged data lands on the same surface (same hash), which becomes the current one again.
    .onConflictDoUpdate({
      target: [T.userId, T.sessionId, T.messageKey, T.blockIndex],
      set: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    })
    .run();
  return { kind: input.kind, sessionId, blockIndex: 0, spec: built, builtAt: now.toISOString() };
}

// --- context refs for chat (`@ctx:morning_brief`, `@ctx:week_plan`) ---

function lines(rows: Candidate[], max = 40) {
  return rows.slice(0, max).map((c) => `${c.ref} | ${c.title.replace(/[\n|]/g, " ").slice(0, 80)} | ${c.due ?? "no date"} | ${c.minutes} min`);
}

export function briefContext(user: CurrentUser, now = new Date()) {
  const today = localDate(now, adapterContext(now).timezone);
  const rows = candidates(user, today, now);
  const metrics = [...(can(user, "work.ai") ? ["metric:ai_spend_today", "metric:ai_spend_7d"] : []), "metric:items_done_14d", "metric:overdue_count"];
  return [
    `Morning brief for ${today}. Use ApprovalChips for the rows, Gauge/Sparkline with these metric refs (Jarvis fills in the numbers): ${metrics.join(", ")}.`,
    `Due today or overdue (${rows.length}). Columns: ref | title | due | estimate`,
    ...(rows.length ? lines(rows) : ["(none)"]),
  ].join("\n");
}

export function weekContext(user: CurrentUser, now = new Date()) {
  const today = localDate(now, adapterContext(now).timezone);
  const weekOf = planWeekOf(today);
  const end = addDays(weekOf, 4);
  const rows = candidates(user, end, now, { undated: true });
  const cal = calendarWeek(user, calendarRef(weekOf, 5), now);
  const events =
    "events" in cal ? cal.events.map((e) => `${e.day} ${e.allDay ? "all day" : `${e.start}${e.end ? `–${e.end}` : ""}`} ${e.title.slice(0, 60)}`) : [];
  return [
    `Week plan: WeekPlan weekOf ${weekOf} (Mon–Fri, today ${today}). Place blocks on days ≥ today, 07:00–21:00, around these fixed events (Jarvis shows them; don't add them as blocks):`,
    ...(events.length ? events.slice(0, 40) : ["(no calendar events)"]),
    `Work to place (${rows.length}). Columns: ref | title | due | estimate`,
    ...(rows.length ? lines(rows) : ["(none)"]),
  ].join("\n");
}
