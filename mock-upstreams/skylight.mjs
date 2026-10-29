// Mock Skylight unofficial API (OAuth refresh-token rotation + JSON:API resources).
import { randomBytes } from "node:crypto";
import { json, readBody, notFound, addDays } from "./util.mjs";

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
  const state = { refresh: null, access: null, chores: new Map() };

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
    ]);
  }
  seed();

  async function handle(req, res, path, url, control) {
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
    if ((match = path.match(/^\/api\/frames\/([^/]+)\/calendar_events$/))) {
      const today = new Date();
      const at = (d, h) => {
        const x = addDays(today, d);
        x.setHours(h, 30, 0, 0);
        return x.toISOString();
      };
      return json(res, 200, {
        data: [
          {
            id: "ev1-1",
            type: "calendar_event",
            attributes: { summary: "Dentist — Will", location: "Main St Dental", starts_at: at(0, 16), ends_at: at(0, 17), all_day: false },
          },
          {
            id: "ev2",
            type: "calendar_event",
            attributes: { summary: "Family dinner at Grandma's", location: null, starts_at: at(1, 17), ends_at: at(1, 19), all_day: false },
          },
        ],
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
    if ((match = path.match(/^\/api\/frames\/([^/]+)\/chores$/))) {
      if (!url.searchParams.get("after") || !url.searchParams.get("before")) return json(res, 422, { errors: ["after can't be blank"] });
      return json(res, 200, {
        data: [...state.chores.values()].map((c) => ({
          id: c.id,
          type: "chore",
          attributes: { ...c, category: undefined, start: choreDay(c.start_time), recurring: c.id.includes("-") },
          relationships: { category: { data: c.category ? { id: c.category, type: "category" } : null } },
        })),
      });
    }
    return notFound(res);
  }
  return { handle, reset: seed, state };
}
