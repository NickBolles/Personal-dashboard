// Mock Google Tasks API + OAuth token/authorize endpoints.
import { randomBytes } from "node:crypto";
import { json, readBody, notFound, isoDate, addDays } from "./util.mjs";

export function createGoogleTasks({ clientId, clientSecret, refreshToken }) {
  const state = { access: new Set(), tasks: new Map(), codes: new Map() };

  function seed() {
    state.tasks.clear();
    const today = new Date();
    const due = (d) => `${isoDate(addDays(today, d))}T00:00:00.000Z`;
    const add = (id, title, d, extra = {}) =>
      state.tasks.set(id, {
        kind: "tasks#task",
        id,
        title,
        status: "needsAction",
        due: d === null ? undefined : due(d),
        updated: new Date(Date.now() - 3600e3).toISOString(),
        webViewLink: `https://tasks.google.com/task/${id}`,
        ...extra,
      });
    add("gt-1", "Renew car registration", -2, { notes: "DMV online" });
    add("gt-2", "Call plumber about water heater", 0);
    add("gt-3", "Book flights for Thanksgiving", 3);
    add("gt-4", "Sort garage shelves", null);
    add("gt-5", "Pick up dry cleaning", -1, { status: "completed", completed: new Date(Date.now() - 1800e3).toISOString() });
  }
  seed();

  async function handle(req, res, path, url, control) {
    const m = req.method;
    let match;
    if (path === "/o/oauth2/v2/auth") {
      // Simulate Google consent: immediately redirect back with a code.
      const code = randomBytes(8).toString("hex");
      state.codes.set(code, url.searchParams.get("redirect_uri"));
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (path === "/token" && m === "POST") {
      const body = await readBody(req);
      if (body.client_id !== clientId || body.client_secret !== clientSecret) return json(res, 401, { error: "invalid_client" });
      if (body.grant_type === "authorization_code" && state.codes.has(body.code)) {
        state.codes.delete(body.code);
        const at = `ya29.mock_${randomBytes(6).toString("hex")}`;
        state.access.add(at);
        return json(res, 200, {
          access_token: at,
          expires_in: 3599,
          refresh_token: refreshToken,
          scope: "https://www.googleapis.com/auth/tasks",
          token_type: "Bearer",
        });
      }
      if (body.grant_type === "refresh_token" && body.refresh_token === refreshToken) {
        const at = `ya29.mock_${randomBytes(6).toString("hex")}`;
        state.access.add(at);
        return json(res, 200, { access_token: at, expires_in: 3599, scope: "https://www.googleapis.com/auth/tasks", token_type: "Bearer" });
      }
      return json(res, 400, { error: "invalid_grant" });
    }
    if (control.fail.has("todos")) return json(res, 503, { error: { code: 503, message: "Backend Error" } });
    const auth = (req.headers.authorization ?? "").replace("Bearer ", "");
    if (!state.access.has(auth))
      return json(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });
    if (path === "/tasks/v1/users/@me/lists") {
      return json(res, 200, {
        kind: "tasks#taskLists",
        items: [
          { id: "MDEyMzQ1", title: "My Tasks", updated: new Date().toISOString() },
          { id: "list-house", title: "House", updated: new Date().toISOString() },
        ],
      });
    }
    if ((match = path.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks$/)) && m === "GET") {
      const showCompleted = url.searchParams.get("showCompleted") === "true";
      const items = [...state.tasks.values()].filter((t) => showCompleted || t.status !== "completed");
      return json(res, 200, { kind: "tasks#tasks", items });
    }
    if ((match = path.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks$/)) && m === "POST") {
      const body = await readBody(req);
      const id = `gt-${Date.now()}`;
      state.tasks.set(id, {
        kind: "tasks#task",
        id,
        title: body.title,
        notes: body.notes,
        due: body.due,
        status: "needsAction",
        updated: new Date().toISOString(),
      });
      return json(res, 200, state.tasks.get(id));
    }
    if ((match = path.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)$/))) {
      const t = state.tasks.get(decodeURIComponent(match[2]));
      if (!t) return json(res, 404, { error: { code: 404, message: "Task not found" } });
      if (m === "GET") return json(res, 200, t);
      if (m === "PATCH") {
        const body = await readBody(req);
        Object.assign(t, body, { updated: new Date().toISOString() });
        if (body.status === "completed") t.completed = new Date().toISOString();
        if (body.status === "needsAction") delete t.completed;
        return json(res, 200, t);
      }
    }
    return notFound(res);
  }
  return { handle, reset: seed, state };
}
