// Mock Skylight unofficial API (OAuth refresh-token rotation + JSON:API resources).
import { randomBytes } from "node:crypto";
import { json, readBody, notFound, addDays, isoDate } from "./util.mjs";

// The mock frame's timezone (matches the e2e server's TZ).
const FRAME_TZ = "America/Chicago";

/** Local date + "HH:MM" of `d` in the frame timezone. */
function frameNow(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: FRAME_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Day a chore is scheduled on, in the frame's local calendar. Timed chores
 * roll to tomorrow once their time has passed, so the seeded chores are never
 * overdue: otherwise Home's overdue counts depend on the wall clock (e.g. the
 * 18:00 chore turned overdue between 18:00 local and midnight UTC).
 */
export function choreDay(startTime, d = new Date()) {
  const now = frameNow(d);
  if (!startTime || startTime > now.time) return now.date;
  return frameNow(addDays(d, 1)).date;
}

export function createSkylight({ refreshToken }) {
  const state = { refresh: null, access: null, chores: new Map(), lists: new Map(), events: new Map(), writes: [], nextItem: 8000, nextEvent: 1 };
  const familyCalendar = "family-mock@group.calendar.google.com";
  const resource = (c) => ({
    id: c.id,
    type: "chore",
    attributes: { ...c, category: undefined, recurring: c.id.includes("-") },
    relationships: { category: { data: c.category ? { id: c.category, type: "category" } : null } },
  });
  const invalid = (res) => json(res, 422, { errors: { summary: ["can't be blank"] } });
  const keysOnly = (body, keys) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((k) => keys.includes(k));
  const nonempty = (s) => typeof s === "string" && s.trim().length > 0;
  const eventKeys = [
    "summary",
    "description",
    "all_day",
    "starts_at",
    "ends_at",
    "timezone",
    "calendar_id",
    "calendar_account_id",
    "source_calendar_id",
    "invited_emails",
    "rrule",
    "location",
  ];
  function validEvent(body, previous) {
    if (!keysOnly(body, eventKeys)) return false;
    const e = { ...previous, ...body };
    if (!nonempty(e.summary) || !nonempty(e.timezone) || typeof e.all_day !== "boolean") return false;
    const pattern = e.all_day ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (![e.starts_at, e.ends_at].every((s) => typeof s === "string" && pattern.test(s) && Number.isFinite(Date.parse(s)))) return false;
    if (Date.parse(e.ends_at) <= Date.parse(e.starts_at)) return false;
    return e.calendar_id == null || e.calendar_id === familyCalendar;
  }

  function seed() {
    // Token rotation state survives /__mock/reset (like a real account); only data is reset.
    state.refresh ??= refreshToken;
    state.chores = new Map([
      ["55900629", { id: "55900629", summary: "Schedule vet appointment", emoji_icon: "🐾", status: "pending", start_time: null }],
      [
        "55780859-" + choreDay("18:00") + "-1800",
        {
          id: "55780859-" + choreDay("18:00") + "-1800",
          summary: "Take out recycling",
          emoji_icon: "♻️",
          status: "pending",
          start_time: "18:00",
          category: "13600771",
        },
      ],
      ["55900777", { id: "55900777", summary: "Practice piano scales", emoji_icon: "🎹", status: "pending", start_time: null, category: "13600772" }],
      // Done today (frame-local date): kept as "completed" for Done today / Recently completed / Todos.
      [
        "55900812",
        {
          id: "55900812",
          summary: "Wipe the kitchen counters",
          emoji_icon: "🧽",
          status: "complete",
          completed_on: choreDay(null),
          start_time: null,
          category: "13600771",
        },
      ],
      // Skipped and earlier-day completions are dropped by the adapter.
      ["55900813", { id: "55900813", summary: "Sort the mail pile", emoji_icon: "✉️", status: "skipped", start_time: null, category: "13600771" }],
    ]);
    const now = new Date();
    const day = (n) => frameNow(addDays(now, n)).date;
    for (const c of [
      { id: "55900814", summary: "Put away the board games", category: "13600772", start: day(-1), completed_on: day(-1), status: "complete" },
      { id: "55900815", summary: "Clean the coffee maker", category: "13600771", start: day(-2), completed_on: day(-2), status: "complete" },
      { id: "55900816", summary: "Check the smoke alarms", category: "13600771", start: day(3), status: "pending" },
      { id: "55900817", summary: "Water the porch plants", emoji_icon: "🪴", category: "14463836", start: day(0), status: "pending" },
    ])
      state.chores.set(c.id, { start_time: null, ...c });
    for (const c of state.chores.values()) c.start ??= choreDay(c.start_time);
    const list = (id, label, kind, items) => ({
      id,
      type: "list",
      attributes: { label, kind, color: "#4fd8c4" },
      items: new Map(
        items.map(([itemId, label, status], position) => [itemId, { id: itemId, type: "list_item", attributes: { label, status, section: null, position } }]),
      ),
    });
    state.lists = new Map([
      [
        "7001",
        list("7001", "Groceries", "shopping", [
          ["7101", "Oat milk", "pending"],
          ["7102", "Coffee beans", "pending"],
          ["7103", "Paper towels", "completed"],
        ]),
      ],
      ["7002", list("7002", "House projects", "to_do", [["7201", "Replace furnace filter", "pending"]])],
    ]);
    const at = (d, hour) => {
      // Use the frame's wall clock, not the host timezone (including DST transitions).
      let t = Date.parse(`${day(d)}T${String(hour).padStart(2, "0")}:30:00Z`);
      for (let i = 0; i < 3; i++) {
        const p = frameNow(new Date(t));
        t += Date.parse(`${day(d)}T${String(hour).padStart(2, "0")}:30:00Z`) - Date.parse(`${p.date}T${p.time}:00Z`);
      }
      return new Date(t).toISOString();
    };
    const event = (id, summary, location, d, start, end) => ({
      id,
      type: "calendar_event",
      attributes: {
        summary,
        description: null,
        location,
        starts_at: at(d, start),
        ends_at: at(d, end),
        all_day: false,
        timezone: FRAME_TZ,
        calendar_id: familyCalendar,
        calendar_account_id: 1344358,
        source_calendar_id: 4005307,
        editable: true,
      },
    });
    state.events = new Map([
      ["ev1-1", event("ev1-1", "Dentist — Will", "Main St Dental", 0, 16, 17)],
      ["ev2", event("ev2", "Family dinner at Grandma's", null, 1, 17, 19)],
    ]);
    state.writes = [];
    state.nextItem = 8000;
    state.nextEvent = 1;
  }
  seed();

  async function handle(req, res, path, url, control) {
    if (path === "/__mock/skylight/writes" && req.method === "GET") return json(res, 200, { writes: state.writes });
    if (control.fail.has("skylight")) return json(res, 503, { errors: ["unavailable"] });
    const m = req.method;
    let match;
    if (path === "/oauth/token" && m === "POST") {
      const body = await readBody(req);
      if (body.grant_type === "refresh_token" && body.refresh_token === state.refresh) {
        state.refresh = `sk_rt_${randomBytes(8).toString("hex")}`;
        state.access = `sk_at_${randomBytes(8).toString("hex")}`;
        return json(res, 200, {
          access_token: state.access,
          token_type: "Bearer",
          expires_in: 7200,
          refresh_token: state.refresh,
          created_at: Math.floor(Date.now() / 1000),
        });
      }
      return json(res, 400, { error: "invalid_grant", error_description: "The provided authorization grant is invalid" });
    }
    if (path.startsWith("/api/") && !/^\d{4}-\d{2}-\d{2}$/.test(req.headers["skylight-api-version"] ?? ""))
      return json(res, 400, { errors: ["invalid api version"] });
    if (!state.access || req.headers.authorization !== `Bearer ${state.access}`) return json(res, 401, { errors: ["Invalid token"] });
    if (path === "/api/frames") {
      return json(res, 200, {
        data: [
          {
            id: "4418006",
            type: "frame_show",
            attributes: { name: "Kitchen Calendar", household_name: "The Bolles Family", timezone: "America/Chicago", mine: true },
          },
        ],
      });
    }
    if (/^\/api\/frames\/[^/]+\/source_calendars$/.test(path) && m === "GET") {
      return json(res, 200, {
        data: [
          { id: "4005307", type: "source_calendar", attributes: { name: "Family", calendar_id: familyCalendar, calendar_account_id: 1344358, writable: true } },
          { id: "4005308", type: "source_calendar", attributes: { name: "US Holidays", writable: false } },
        ],
      });
    }
    if (/^\/api\/frames\/[^/]+\/calendar_events$/.test(path) && m === "GET") {
      const min = url.searchParams.get("date_min");
      const max = url.searchParams.get("date_max");
      return json(res, 200, {
        data: [...state.events.values()].filter((e) => {
          const day = e.attributes.all_day ? e.attributes.starts_at : isoDate(new Date(e.attributes.starts_at));
          return (!min || day >= min) && (!max || day < max);
        }),
      });
    }
    if (/^\/api\/frames\/[^/]+\/categories$/.test(path)) {
      const cat = (id, label, linked) => ({
        id,
        type: "category",
        attributes: { id: Number(id), label, color: "#CB434C", linked_to_profile: linked, selected_for_chore_chart: linked },
      });
      return json(res, 200, { data: [cat("13600771", "Nick", true), cat("13600772", "Will", true), cat("14463836", "Family", false)] });
    }
    if ((match = path.match(/^\/api\/frames\/([^/]+)\/chores$/)) && m === "GET") {
      if (!url.searchParams.get("after") || !url.searchParams.get("before")) return json(res, 422, { errors: ["after can't be blank"] });
      const chores = [...state.chores.values()].filter((c) => c.start >= url.searchParams.get("after") && c.start <= url.searchParams.get("before"));
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const next = new URLSearchParams(url.searchParams);
      next.set("page", String(page + 1));
      return json(res, 200, {
        data: chores.slice((page - 1) * 6, page * 6).map(resource),
        ...(page * 6 < chores.length ? { links: { next: `${path}?${next}` } } : {}),
        meta: { total: chores.length },
      });
    }
    if (/^\/api\/frames\/[^/]+\/lists$/.test(path) && m === "GET") {
      return json(res, 200, { data: [...state.lists.values()].map(({ id, type, attributes }) => ({ id, type, attributes })) });
    }
    if ((match = path.match(/^\/api\/frames\/[^/]+\/lists\/([^/]+)$/)) && m === "GET") {
      const l = state.lists.get(match[1]);
      if (!l) return notFound(res);
      return json(res, 200, { data: { id: l.id, type: l.type, attributes: l.attributes }, included: [...l.items.values()] });
    }
    if (!["POST", "PUT", "DELETE"].includes(m)) return notFound(res);
    const body = await readBody(req);
    if (body?.data) return invalid(res);
    const accepted = (status, result) => {
      state.writes.push({ method: m, path, body });
      if (status === 204) {
        res.writeHead(204);
        return res.end();
      }
      return json(res, status, { data: result });
    };
    if ((match = path.match(/^\/api\/frames\/[^/]+\/chores\/([^/]+)(\/completions)?$/)) && m === "PUT") {
      // Real API: completions take the BASE chore id in the path; the occurrence goes in the body.
      if (match[2] && /-\d{4}-\d{2}-\d{2}/.test(match[1])) return invalid(res);
      const occurrence = () => {
        const date = typeof body?.instance_date === "string" ? body.instance_date : null;
        if (!date) return undefined;
        const time = typeof body.instance_time === "string" ? body.instance_time.replace(":", "") : null;
        return state.chores.get(`${match[1]}-${date}${time ? `-${time}` : ""}`) ?? state.chores.get(`${match[1]}-${date}`);
      };
      const c = state.chores.get(match[1]) ?? (match[2] ? occurrence() : undefined);
      if (!c) return notFound(res);
      if (match[2]) {
        if (
          !keysOnly(body, ["status", "instance_date", "instance_time", "category_id"]) ||
          !["complete", "pending"].includes(body.status) ||
          (c.id.includes("-") && !body.instance_date)
        )
          return invalid(res);
        c.status = body.status;
        c.completed_on = body.status === "complete" ? frameNow().date : null;
      } else {
        if (
          !keysOnly(body, ["category_id", "start", "summary"]) ||
          ("category_id" in body && body.category_id !== null && (typeof body.category_id !== "number" || !Number.isFinite(body.category_id)))
        )
          return invalid(res);
        if ("category_id" in body) c.category = body.category_id == null ? null : String(body.category_id);
        if ("start" in body) c.start = body.start;
        if ("summary" in body) c.summary = body.summary;
      }
      return accepted(200, resource(c));
    }
    if ((match = path.match(/^\/api\/frames\/[^/]+\/lists\/([^/]+)\/list_items(?:\/([^/]+))?$/))) {
      const l = state.lists.get(match[1]);
      if (!l) return notFound(res);
      if (m === "POST" && !match[2]) {
        if (!keysOnly(body, ["label"]) || !nonempty(body.label)) return invalid(res);
        const item = {
          id: String(state.nextItem++),
          type: "list_item",
          attributes: { label: body.label, status: "pending", section: null, position: l.items.size },
        };
        l.items.set(item.id, item);
        return accepted(201, item);
      }
      const item = l.items.get(match[2]);
      if (!item) return notFound(res);
      if (m === "DELETE") {
        l.items.delete(item.id);
        return accepted(204);
      }
      if (m === "PUT") {
        if (
          !keysOnly(body, ["label", "status"]) ||
          ("label" in body && !nonempty(body.label)) ||
          ("status" in body && !["pending", "completed"].includes(body.status))
        )
          return invalid(res);
        Object.assign(item.attributes, body);
        return accepted(200, item);
      }
    }
    if ((match = path.match(/^\/api\/frames\/[^/]+\/calendar_events(?:\/([^/]+))?$/))) {
      if (m === "POST" && !match[1]) {
        if (!validEvent(body)) return invalid(res);
        const e = {
          id: `ev-${state.nextEvent++}`,
          type: "calendar_event",
          attributes: { ...body, description: body.description ?? null, location: body.location ?? null, editable: true },
        };
        state.events.set(e.id, e);
        return accepted(201, e);
      }
      const e = state.events.get(match[1]);
      if (!e) return notFound(res);
      if (m === "DELETE") {
        state.events.delete(e.id);
        return accepted(204);
      }
      if (m === "PUT") {
        if (!validEvent(body, e.attributes)) return invalid(res);
        Object.assign(e.attributes, body);
        return accepted(200, e);
      }
    }
    return notFound(res);
  }
  return { handle, reset: seed, state };
}
