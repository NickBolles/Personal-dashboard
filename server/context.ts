import "server-only";
import { SOURCE_LABELS, type ActionSource, type CalendarEvent, type HomeHealth, type NextAction } from "@/lib/contracts";
import { adapterContext, cachedSource, getHome } from "@/server/sources";
import { listControls } from "@/integrations/home-assistant/controls";

/**
 * "Ask Hermes about …": a plain-text snapshot of what Jarvis currently knows
 * about a source, attached to a Hermes message. Built on the server so the web
 * app and the phone app attach the same thing. Reads cached snapshots (fast);
 * Home Assistant controls are read live because their states matter.
 */
export const CONTEXT_SOURCES = ["overview", "skylight", "home_assistant", "todos", "daily_compass", "paperclip"] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

const MAX_CHARS = 6000;

function fmtTime(iso: string | undefined, tz: string, withDay = false) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: tz,
    ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtEvent(e: CalendarEvent, tz: string) {
  const when = e.allDay
    ? `${new Date(`${e.startsAt}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })} (all day)`
    : `${fmtTime(e.startsAt, tz, true)}${e.endsAt ? `–${fmtTime(e.endsAt, tz)}` : ""}`;
  return `- ${when}: ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.calendar ? ` [${e.calendar}]` : ""}`;
}

function fmtAction(a: NextAction, tz: string) {
  const due = a.dueAt ? ` (due ${a.dueIsDate ? a.dueAt.slice(0, 10) : fmtTime(a.dueAt, tz, true)})` : "";
  return `- ${a.title}${due}${a.detail ? ` — ${a.detail}` : ""} [${a.source}:${a.sourceId}]`;
}

function header(source: ActionSource) {
  const r = cachedSource(source);
  const s = r.status;
  const freshness = s.fetchedAt ? `as of ${fmtTime(s.fetchedAt, adapterContext().timezone, true)}` : "not read yet";
  const state = s.state === "ok" ? "" : ` (${s.state}${s.error ? `: ${s.error}` : ""})`;
  return { r, line: `${SOURCE_LABELS[source]} — ${freshness}${state}` };
}

async function skylight(tz: string) {
  const { r, line } = header("skylight");
  const events = (r.data?.events ?? []).slice(0, 40);
  const chores = (r.data?.actions ?? []).filter((a) => a.status === "open");
  return [
    line,
    events.length ? "Calendar (next 7 days):" : "Calendar: nothing in the next 7 days.",
    ...events.map((e) => fmtEvent(e, tz)),
    chores.length ? "Open chores today:" : "Chores: none open today.",
    ...chores.map((a) => fmtAction(a, tz)),
  ];
}

async function homeAssistant(tz: string) {
  const { r, line } = header("home_assistant");
  const ex = r.data?.homeExceptions ?? [];
  const lines = [line, ex.length ? "Exceptions in watched entities:" : "Exceptions: none in watched entities."];
  for (const e of ex) lines.push(`- ${e.name} (${e.entityId}): ${e.reason}, state "${e.state}"${e.since ? ` since ${fmtTime(e.since, tz, true)}` : ""}`);
  try {
    const controls = await listControls();
    if (controls.length) {
      lines.push("Controllable entities (live):");
      for (const c of controls) lines.push(`- ${c.name} (${c.entityId}): ${c.state}${c.lastChanged ? ` since ${fmtTime(c.lastChanged, tz, true)}` : ""}`);
    }
  } catch {
    lines.push("Controllable entities: couldn't read live state right now.");
  }
  const h = r.data?.extra?.health as HomeHealth | undefined;
  if (h) {
    const v = (n?: number) => (n === undefined ? "unknown" : String(n));
    lines.push(
      `Health: ${h.entities} entities, ${h.unavailable} unavailable, ${h.unknown} unknown, updates pending ${v(h.updatesPending)}, integrations failing ${v(h.integrationsFailing)}${h.failingDomains?.length ? ` (${h.failingDomains.join(", ")})` : ""}.`,
    );
  }
  const events = (r.data?.events ?? []).slice(0, 20);
  if (events.length) lines.push("Home Assistant calendars:", ...events.map((e) => fmtEvent(e, tz)));
  return lines;
}

async function simpleActions(source: ActionSource, tz: string, emptyLabel: string) {
  const { r, line } = header(source);
  const open = (r.data?.actions ?? []).filter((a) => a.status === "open" || a.status === "waiting").slice(0, 40);
  return [line, ...(open.length ? open.map((a) => fmtAction(a, tz)) : [emptyLabel])];
}

async function compass() {
  const { r, line } = header("daily_compass");
  const c = r.data?.compass;
  if (!c) return [line, "No state yet."];
  return [
    line,
    `Today (${c.date}): ${c.completed ? `checked in${c.completedAt ? ` at ${fmtTime(c.completedAt, adapterContext().timezone)}` : ""}` : "not checked in yet"}; window ${c.windowStart}–${c.windowEnd}${c.inWindow ? " (open now)" : ""}.`,
    ...(c.summary ? [`Status: ${c.summary}`] : []),
  ];
}

async function overview(tz: string) {
  const home = await getHome({ live: false });
  const lines = ["Jarvis overview:"];
  lines.push(home.now.length ? "Now:" : "Now: nothing urgent.", ...home.now.map((a) => fmtAction(a, tz)));
  if (home.later.laterToday.length) lines.push("Later today:", ...home.later.laterToday.map((a) => fmtAction(a, tz)));
  if (home.glance.nextEvent) lines.push(`Next event: ${fmtEvent(home.glance.nextEvent, tz).slice(2)}`);
  const degraded = home.sources.filter((s) => !["ok", "disabled", "unconfigured"].includes(s.state));
  if (degraded.length) lines.push(`Sources with problems: ${degraded.map((s) => `${s.label} (${s.state})`).join(", ")}`);
  return lines;
}

export async function sourceContext(source: ContextSource): Promise<string> {
  const tz = adapterContext().timezone;
  const lines =
    source === "skylight"
      ? await skylight(tz)
      : source === "home_assistant"
        ? await homeAssistant(tz)
        : source === "todos"
          ? await simpleActions("todos", tz, "No open todos.")
          : source === "paperclip"
            ? await simpleActions("paperclip", tz, "No open initiatives.")
            : source === "daily_compass"
              ? await compass()
              : await overview(tz);
  return lines.join("\n");
}

/** Combined context for a Hermes message: each source block, then any free-form context. */
export async function buildContext(sources: ContextSource[] | undefined, extra: string | undefined) {
  const blocks = await Promise.all([...new Set(sources ?? [])].map(sourceContext));
  const text = [...blocks, ...(extra ? [extra] : [])].join("\n\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…(truncated)` : text;
}
