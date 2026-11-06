import "server-only";
import { resolveIntegration } from "@/integrations/store";
import { frameId, skylightRequest } from "./adapter";
import { doneLabel, type SkylightEventFields, type SkylightWriteOp } from "@/lib/skylight-write";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { processSingleton } from "@/server/singleton";

type Created = { itemId?: string; eventId?: string; toCategoryId?: string };
type CalendarTarget = { calendar_id: string; calendar_account_id: number; source_calendar_id: number };
type SourceCalendar = {
  id: string;
  attributes: {
    writable?: boolean;
    read_only?: boolean;
    name?: string;
    summary?: string;
    label?: string;
    calendar_id?: string;
    external_id?: string;
    calendar_account_id?: string | number;
  };
  relationships?: { calendar_account?: { data?: { id: string } | null } };
};
const state = processSingleton("skylight_writes", () => ({
  users: new Map<string, number[]>(),
  tail: Promise.resolve(),
  lastWrite: -Infinity,
  calendars: new Map<string, Promise<CalendarTarget | undefined>>(),
}));

/** The owner's Skylight member: configured, else the one the last read auto-matched (extra.mine). */
async function ownerMember(): Promise<string | undefined> {
  const configured = resolveIntegration("skylight")
    .config.members?.split(",")
    .map((id) => id.trim())
    .find(Boolean);
  if (configured) return configured;
  const { cachedSource } = await import("@/server/sources");
  const mine = cachedSource("skylight").data?.extra?.mine;
  return Array.isArray(mine) && typeof mine[0] === "string" ? mine[0] : undefined;
}

export function assertSkylightWritable() {
  const r = resolveIntegration("skylight");
  if (!r.enabled) throw new HttpError(409, "disabled", "Connect Skylight in Settings → Connections first.");
  if (r.config.mode !== "direct")
    throw new HttpError(409, "hermes_mode", "Skylight changes need the direct connection (Settings → Connections → Skylight → Directly).");
  if (r.config.writes === "false") throw new HttpError(403, "writes_off", "Skylight changes are off in Settings → Connections → Skylight.");
}

/** Reserve the user's budget before yielding; concurrent requests cannot bypass it. */
function reserve(userId: string) {
  const now = Date.now();
  for (const [id, times] of state.users) {
    const recent = times.filter((at) => at > now - 60_000);
    if (recent.length) state.users.set(id, recent);
    else state.users.delete(id);
  }
  const times = state.users.get(userId) ?? [];
  if (times.length >= 12) throw new HttpError(429, "rate_limited", "Too many Skylight changes at once — wait a moment.");
  state.users.set(userId, [...times, now]);
}

/** Serialize upstream writes across route/worker bundles and leave a minimum 250 ms gap. */
async function write<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const run = state.tail.then(async () => {
    const gap = 250 - (Date.now() - state.lastWrite);
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    state.lastWrite = Date.now();
    return skylightRequest<T>(method, path, { ...(body !== undefined ? { body } : {}) });
  });
  state.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function calendarTarget(f: string): Promise<Partial<CalendarTarget>> {
  const c = resolveIntegration("skylight").config;
  if (c.eventCalendarId && c.eventCalendarAccountId && c.eventSourceCalendarId)
    return { calendar_id: c.eventCalendarId, calendar_account_id: Number(c.eventCalendarAccountId), source_calendar_id: Number(c.eventSourceCalendarId) };
  // Cache discovery (including "none") once per connection/frame, sharing concurrent lookups.
  const key = `${c.baseUrl}|${f}`;
  if (!state.calendars.has(key)) {
    state.calendars.set(
      key,
      (async () => {
        const doc = await skylightRequest<{ data: SourceCalendar[] }>("GET", `/frames/${f}/source_calendars`);
        const writable = doc.data.filter((r) => r.attributes.writable !== false && r.attributes.read_only !== true);
        const r = writable.find((r) => /family/i.test([r.attributes.name, r.attributes.summary, r.attributes.label].filter(Boolean).join(" "))) ?? writable[0];
        if (!r) return undefined;
        const calendar = r.attributes.calendar_id ?? r.attributes.external_id;
        const account = Number(r.attributes.calendar_account_id ?? r.relationships?.calendar_account?.data?.id);
        const source = Number(r.id);
        if (!calendar || !Number.isFinite(account) || !Number.isFinite(source)) return undefined;
        return { calendar_id: calendar, calendar_account_id: account, source_calendar_id: source };
      })(),
    );
  }
  return (await state.calendars.get(key)) ?? {};
}

async function eventBody(event: SkylightEventFields) {
  const { adapterContext } = await import("@/server/sources");
  return {
    summary: event.summary,
    description: event.description ?? null,
    all_day: event.allDay,
    starts_at: event.allDay ? event.startsAt.slice(0, 10) : event.startsAt,
    ends_at: event.allDay ? event.endsAt.slice(0, 10) : event.endsAt,
    timezone: adapterContext().timezone,
    location: event.location ?? null,
  };
}

const OCCURRENCE = /^([A-Za-z0-9_]+)-(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?$/;
const completionPath = (choreId: string) => OCCURRENCE.exec(choreId)?.[1] ?? choreId;

type ChoreStatusOp = Extract<SkylightWriteOp, { op: "chore.complete" | "chore.reopen" | "chore.skip" }>;

/**
 * The real completions body (matches the Hermes skylight skill and live-verified clients): flat
 * `{status, instance_date?, instance_time?, category_id?}` with status complete|pending|skipped.
 * `category_id` must be BLANK for a normally-assigned chore — Skylight answers 422 "category_id must be blank"
 * (the 2026-11-05 prod failure) — and is only sent when completing an up-for-grabs chore, naming who did it.
 */
export async function completionBody(op: ChoreStatusOp, owner: () => Promise<string | undefined> = ownerMember) {
  const occ = OCCURRENCE.exec(op.choreId);
  const instanceDate = op.instanceDate ?? occ?.[2];
  const instanceTime = op.instanceTime ?? (occ?.[3] ? `${occ[3]}:${occ[4]}` : undefined);
  const who = op.op === "chore.complete" && op.upForGrabs ? await owner() : undefined;
  return {
    status: op.op === "chore.complete" ? "complete" : op.op === "chore.skip" ? "skipped" : "pending",
    ...(instanceDate != null ? { instance_date: instanceDate } : {}),
    ...(instanceTime != null ? { instance_time: instanceTime } : {}),
    ...(who ? { category_id: Number(who) } : {}),
  };
}

/** Skylight's own reason from an upstream error ("category_id must be blank"), short and secret-free. */
export function skylightReason(err: UpstreamError): string | undefined {
  const m = /returned \d+: ([\s\S]*)$/.exec(err.message);
  const raw = m?.[1]?.trim();
  if (!raw) return undefined;
  let text = raw;
  try {
    const j = JSON.parse(raw) as { errors?: unknown; error?: unknown; message?: unknown };
    const e = j.errors ?? j.error ?? j.message;
    if (typeof e === "string") text = e;
    else if (Array.isArray(e))
      text = e
        .map((x) => (typeof x === "string" ? x : ((x as { detail?: string; title?: string })?.detail ?? (x as { title?: string })?.title ?? JSON.stringify(x))))
        .join("; ");
    else if (e && typeof e === "object")
      text = Object.entries(e as Record<string, unknown>)
        .map(([k, v]) => `${k === "base" ? "" : `${k} `}${Array.isArray(v) ? v.join(", ") : String(v)}`.trim())
        .join("; ");
  } catch {
    // Truncated or non-JSON body: keep the raw text.
  }
  return (
    text
      .replace(/Bearer\s+\S+/gi, "Bearer …")
      .replace(/\s+/g, " ")
      .slice(0, 240) || undefined
  );
}

export async function runSkylightWrite(
  op: SkylightWriteOp,
  user: { id: string },
  _opts: { correlationId: string },
): Promise<{ message: string; created: Created }> {
  assertSkylightWritable();
  if (op.op === "chore.claim" && op.choreId.includes("-")) throw new HttpError(409, "recurring", "Claim recurring chores in Skylight for now.");
  reserve(user.id);
  const created: Created = {};
  try {
    const f = await frameId();
    const base = `/frames/${f}`;
    switch (op.op) {
      case "chore.complete":
      case "chore.reopen":
      case "chore.skip": {
        // Recurring occurrences read as "<baseId>-YYYY-MM-DD[-HHMM]"; the completions URL takes the BASE (series) id
        // and the occurrence goes in the body (docs/research/integrations-api.md, chores).
        await write("PUT", `${base}/chores/${completionPath(op.choreId)}/completions`, await completionBody(op));
        break;
      }
      case "chore.reschedule":
        if (OCCURRENCE.test(op.choreId)) throw new HttpError(409, "recurring", "Move recurring chores in Skylight for now.");
        await write("PUT", `${base}/chores/${op.choreId}`, { start: op.start });
        break;
      case "chore.claim": {
        const to = op.toCategoryId ?? (await ownerMember());
        if (!to) throw new HttpError(409, "pick_member", "Pick your Skylight member in Settings → Connections first.");
        await write("PUT", `${base}/chores/${op.choreId}`, { category_id: Number(to) });
        created.toCategoryId = to;
        break;
      }
      case "chore.assign":
        await write("PUT", `${base}/chores/${op.choreId}`, { category_id: op.toCategoryId == null ? null : Number(op.toCategoryId) });
        break;
      case "list.add": {
        const r = await write<{ data: { id: string | number } }>("POST", `${base}/lists/${op.listId}/list_items`, { label: op.label });
        created.itemId = String(r.data.id);
        break;
      }
      case "list.remove":
        await write("DELETE", `${base}/lists/${op.listId}/list_items/${op.itemId}`);
        break;
      case "list.check":
      case "list.uncheck":
        await write("PUT", `${base}/lists/${op.listId}/list_items/${op.itemId}`, { status: op.op === "list.check" ? "completed" : "pending" });
        break;
      case "event.create": {
        const r = await write<{ data: { id: string | number } }>("POST", `${base}/calendar_events`, {
          ...(await eventBody(op.event)),
          ...(op.event.calendarId || op.event.sourceCalendarId || op.event.calendarAccountId
            ? {
                ...(op.event.calendarId ? { calendar_id: op.event.calendarId } : {}),
                ...(op.event.sourceCalendarId ? { source_calendar_id: Number(op.event.sourceCalendarId) } : {}),
                ...(op.event.calendarAccountId ? { calendar_account_id: Number(op.event.calendarAccountId) } : {}),
              }
            : await calendarTarget(f)),
          invited_emails: [],
          rrule: null,
        });
        created.eventId = String(r.data.id);
        break;
      }
      case "event.update":
        await write("PUT", `${base}/calendar_events/${op.eventId}`, await eventBody(op.event));
        break;
      case "event.delete":
        await write("DELETE", `${base}/calendar_events/${op.eventId}`);
        break;
    }
    return { message: doneLabel(op), created };
  } catch (err) {
    if (err instanceof UpstreamError) {
      if (err.status === 404 || err.kind === "not_found") throw new HttpError(404, "gone", "That isn't in Skylight anymore — refresh.");
      const reason = skylightReason(err);
      throw new HttpError(
        502,
        "skylight_failed",
        err.status === 422
          ? "Skylight couldn't accept that change. Refresh and try again."
          : "Couldn't confirm the Skylight change. Refresh before trying again.",
        { status: err.status ?? null, ...(reason ? { reason } : {}) },
      );
    }
    throw err;
  }
}
