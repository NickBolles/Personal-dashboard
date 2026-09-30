// Mock Home Assistant REST API.
import { json, readBody, bearerOk, notFound, isoDate, addDays } from "./util.mjs";

export function createHomeAssistant({ token }) {
  const state = { entities: new Map(), todos: new Map(), calls: [] };

  function set(entity_id, s, attributes = {}, agoMin = 5) {
    const t = new Date(Date.now() - agoMin * 60000).toISOString();
    state.entities.set(entity_id, {
      entity_id,
      state: s,
      attributes: { friendly_name: attributes.friendly_name ?? entity_id, ...attributes },
      last_changed: t,
      last_updated: t,
      context: { id: "01J9", parent_id: null, user_id: null },
    });
  }

  function seed() {
    state.entities.clear();
    state.todos.clear();
    state.calls = [];
    set("alarm_control_panel.wausau_alarm", "disarmed", { friendly_name: "House alarm" });
    set("lock.front_door_lock", "locked", { friendly_name: "Front door lock" });
    set("cover.garage_door", "open", { friendly_name: "Garage door", device_class: "garage" }, 42);
    set("cover.garage_door_2", "closed", { friendly_name: "Garage door 2", device_class: "garage" });
    set("binary_sensor.front_door_sensor", "off", { friendly_name: "Front door", device_class: "door" });
    set("binary_sensor.back_door", "off", { friendly_name: "Back door", device_class: "door" });
    set("todo.shopping_list", "2", { friendly_name: "Shopping List", supported_features: 127 });
    set("calendar.family_calendar", "off", { friendly_name: "Family" });
    state.todos.set("todo.shopping_list", [
      { uid: "ha-1", summary: "Milk", status: "needs_action" },
      { uid: "ha-2", summary: "Pay water bill", status: "needs_action", due: isoDate(new Date()), description: "Autopay failed" },
    ]);
  }
  seed();

  const serviceEffects = {
    "lock.lock": "locked",
    "lock.unlock": "unlocked",
    "cover.close_cover": "closed",
    "cover.open_cover": "open",
    "alarm_control_panel.alarm_arm_away": "armed_away",
    "alarm_control_panel.alarm_disarm": "disarmed",
  };

  async function handle(req, res, path, url, control) {
    if (control.fail.has("home_assistant")) return json(res, 503, { message: "unavailable" });
    if (!bearerOk(req, token)) return json(res, 401, { message: "Invalid access token or password" });
    const m = req.method;
    let match;
    if (path === "/api/" || path === "/api") return json(res, 200, { message: "API running." });
    if (path === "/api/config") return json(res, 200, { location_name: "Home", time_zone: "America/Chicago", version: "2026.10.0" });
    if (path === "/api/states") return json(res, 200, [...state.entities.values()]);
    if ((match = path.match(/^\/api\/states\/(.+)$/))) {
      const e = state.entities.get(decodeURIComponent(match[1]));
      return e ? json(res, 200, e) : json(res, 404, { message: "Entity not found." });
    }
    if (path === "/api/calendars") return json(res, 200, [{ entity_id: "calendar.family_calendar", name: "Family" }]);
    if ((match = path.match(/^\/api\/calendars\/(.+)$/))) {
      if (!url.searchParams.get("start") || !url.searchParams.get("end")) return json(res, 400, { message: "missing start/end" });
      const today = new Date();
      const at = (h, d = 0) => {
        const x = addDays(today, d);
        x.setHours(h, 0, 0, 0);
        return x.toISOString();
      };
      return json(res, 200, [
        {
          start: { dateTime: at(18) },
          end: { dateTime: at(19) },
          summary: "Soccer practice",
          description: "Bring water",
          location: "Field 3",
          uid: "evt-77",
          recurrence_id: null,
          rrule: null,
        },
        {
          start: { date: isoDate(addDays(today, 2)) },
          end: { date: isoDate(addDays(today, 3)) },
          summary: "School holiday",
          description: null,
          location: null,
          uid: "hol-1",
          recurrence_id: null,
          rrule: null,
        },
      ]);
    }
    if ((match = path.match(/^\/api\/services\/([^/]+)\/([^/]+)$/)) && m === "POST") {
      const [, domain, service] = match;
      const body = await readBody(req);
      const wantsResponse = url.searchParams.has("return_response");
      state.calls.push({ domain, service, body, at: new Date().toISOString() });
      if (domain === "todo" && service === "get_items") {
        if (!wantsResponse) return json(res, 400, { message: "Service call requires responses but caller did not ask for responses" });
        const ids = [].concat(body.entity_id);
        const statuses = body.status ? [].concat(body.status) : null;
        const service_response = Object.fromEntries(
          ids.map((id) => [id, { items: (state.todos.get(id) ?? []).filter((i) => !statuses || statuses.includes(i.status)) }]),
        );
        return json(res, 200, { changed_states: [], service_response });
      }
      if (domain === "todo" && service === "update_item") {
        const list = state.todos.get(body.entity_id) ?? [];
        const item = list.find((i) => i.uid === body.item) ?? list.find((i) => i.summary === body.item);
        if (!item) return json(res, 400, { message: "Unable to find to-do list item" });
        if (body.status) item.status = body.status;
        if (body.due_date) item.due = body.due_date;
        if (body.due_datetime) item.due = body.due_datetime;
        return json(res, 200, [state.entities.get(body.entity_id)]);
      }
      if (domain === "todo" && service === "add_item") {
        const list = state.todos.get(body.entity_id) ?? [];
        list.push({ uid: `ha-${Date.now()}`, summary: body.item, status: "needs_action", ...(body.due_date ? { due: body.due_date } : {}) });
        state.todos.set(body.entity_id, list);
        return json(res, 200, []);
      }
      const effect = serviceEffects[`${domain}.${service}`];
      if (effect) {
        const e = state.entities.get(body.entity_id);
        if (!e) return json(res, 400, { message: "Entity not found" });
        // Physical devices take a moment to report the new state.
        setTimeout(() => set(body.entity_id, effect, e.attributes, 0), control.physicalDelayMs);
        return json(res, 200, []);
      }
      if (domain === "persistent_notification") return json(res, 200, []);
      return json(res, 400, { message: `Service ${domain}.${service} not found` });
    }
    if (path === "/__mock/ha/set" && m === "POST") {
      const body = await readBody(req);
      const prev = state.entities.get(body.entity_id);
      set(body.entity_id, body.state, { ...(prev?.attributes ?? {}), ...(body.attributes ?? {}) }, body.agoMin ?? 0);
      return json(res, 200, state.entities.get(body.entity_id));
    }
    return notFound(res);
  }
  return { handle, reset: seed, state };
}
