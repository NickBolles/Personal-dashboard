// Mock Hermes API Server — faithful to hermes-agent @ ddd0cc69 contracts
// (docs/research/hermes-api.md). Used for local dev, onboarding demos and E2E.
import { randomBytes } from "node:crypto";
import { json, readBody, bearerOk, notFound, hermesError } from "./util.mjs";

const now = () => Date.now() / 1000;
const hex = (n) => randomBytes(n).toString("hex");

export function createHermes({ apiKey }) {
  const state = {
    sessions: new Map(),
    messages: new Map(), // sessionId -> []
    runs: new Map(),
    idem: new Map(),
    msgSeq: 100,
    compassDone: new Map(), // date -> completedAt ISO
    structuredCount: 0,
  };

  function addSession(s) {
    const session = {
      id: s.id ?? `api_${Math.floor(now())}_${hex(4)}`,
      source: s.source ?? "api_server",
      model: s.model ?? null,
      title: s.title ?? null,
      started_at: s.started_at ?? now(),
      ended_at: null,
      end_reason: null,
      message_count: 0,
      tool_call_count: 0,
      parent_session_id: s.parent_session_id ?? null,
      last_active: s.last_active ?? now(),
      preview: null,
      pinned: false,
      archived: false,
      hidden: false,
      has_system_prompt: false,
      has_model_config: false,
    };
    state.sessions.set(session.id, session);
    state.messages.set(session.id, []);
    return session;
  }

  function addMessage(sessionId, m) {
    const list = state.messages.get(sessionId);
    if (!list) return undefined; // session was reset/deleted while a run was still going
    const msg = { id: ++state.msgSeq, session_id: sessionId, timestamp: now(), ...m };
    list.push(msg);
    const s = state.sessions.get(sessionId);
    s.message_count = list.length;
    s.last_active = msg.timestamp;
    if (m.role === "user" && !s.preview) s.preview = String(m.content).slice(0, 80);
    return msg;
  }

  function seed() {
    for (const run of state.runs.values()) for (const end of run.enders) end();
    state.sessions.clear();
    state.messages.clear();
    state.runs.clear();
    state.idem.clear();
    state.compassDone.clear();
    state.structuredCount = 0;
    const a = addSession({ id: "sess_morning", title: "Morning planning", started_at: now() - 7200, last_active: now() - 3600 });
    addMessage(a.id, { role: "user", content: "What's on my plate today?" });
    addMessage(a.id, {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"weather wausau today"}' } }],
      finish_reason: "tool_calls",
    });
    addMessage(a.id, { role: "tool", content: "Sunny, high of 64°F", tool_call_id: "call_1", tool_name: "web_search" });
    addMessage(a.id, { role: "assistant", content: "You have 3 todos due today and it's sunny — good day for the garage cleanup.", finish_reason: "stop" });
    const b = addSession({ id: "sess_v5", title: "Enable v5 rollout", started_at: now() - 86400, last_active: now() - 80000 });
    addMessage(b.id, { role: "user", content: "Let's plan enabling v5 across the platform." });
    addMessage(b.id, { role: "assistant", content: "Plan: compatibility audit, config migration, rollout, docs, verification.", finish_reason: "stop" });
  }
  seed();

  function pushEvent(run, ev) {
    const e = { ...ev, run_id: run.run_id, timestamp: now(), seq: run.events.length };
    run.events.push(e);
    run.updated_at = e.timestamp;
    run.last_event = e.event;
    for (const sub of run.subscribers) sub(e);
  }

  function finish(run, status, extra = {}) {
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return;
    run.status = status;
    Object.assign(run, extra);
    pushEvent(run, { event: `run.${status}`, ...extra });
    for (const end of run.enders) end();
  }

  /**
   * Structured requests from Jarvis (JARVIS_STRUCTURED_REQUEST source=…):
   * answer with JSON the way a Hermes agent with Skylight / Daily Compass
   * tools would. "FORCE_ERROR" in the task makes it decline; "FORCE_PROSE"
   * makes it answer in prose; "FORCE_APPROVAL" makes it ask for approval.
   */
  function structuredAnswer(source, input) {
    const date = input.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date().toISOString().slice(0, 10);
    if (/FORCE_ERROR/.test(input)) return JSON.stringify({ error: "Skylight tool is not available in this profile" });
    if (/FORCE_PROSE/.test(input)) return "Sure! You have soccer practice at 5:30 and the dog needs feeding.";
    if (source === "skylight") {
      // Fenced on purpose: real models often wrap JSON in a code block.
      const body = {
        events: [
          { title: "Soccer practice", start: `${date}T17:30:00`, end: `${date}T18:30:00`, allDay: false, location: "Field 3" },
          { title: "Grandma visiting", start: date, allDay: true },
        ],
        chores: [
          { id: 9001, title: "Feed the dog", time: "07:30", completed: true },
          { id: 9002, title: "Take out recycling", time: "19:00", completed: false },
          { title: "Water plants", completed: false },
        ],
      };
      return "```json\n" + JSON.stringify(body, null, 2) + "\n```";
    }
    if (source === "daily_compass_complete") {
      if (!state.compassDone.has(date)) state.compassDone.set(date, new Date().toISOString());
    }
    if (source === "daily_compass" || source === "daily_compass_complete") {
      const completedAt = state.compassDone.get(date) ?? null;
      return JSON.stringify({ date, completed: Boolean(completedAt), completedAt, summary: completedAt ? "Checked in" : "Not checked in yet" });
    }
    return JSON.stringify({ error: `No tool for ${source}` });
  }

  /** Scripted agent behaviour, driven by keywords in the input for E2E. */
  async function execute(run, input, instructions) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = run.speed;
    run.status = "running";
    addMessage(run.session_id, { role: "user", content: input });
    await sleep(t);
    // Scripted keywords apply to what the person typed, not to context Jarvis attached.
    const said = input.split("\n\n---\nContext from Jarvis:")[0];
    const structured = typeof instructions === "string" ? instructions.match(/JARVIS_STRUCTURED_REQUEST source=(\w+)/)?.[1] : undefined;
    if (structured) {
      state.structuredCount++;
      if (/FORCE_APPROVAL/.test(input)) {
        run.status = "waiting_for_approval";
        run.approval = { event: "approval.request", command: "skylight write", request_id: hex(8), choices: ["once", "deny"] };
        pushEvent(run, run.approval);
        await new Promise((resolve) => (run.approvalResolver = resolve));
        return;
      }
      const output = structuredAnswer(structured, input);
      addMessage(run.session_id, { role: "assistant", content: output, finish_reason: "stop" });
      return finish(run, "completed", { completed: true, partial: false, interrupted: false, output });
    }
    if (/fail/i.test(said)) {
      await sleep(t);
      return finish(run, "failed", { error: "Mock provider error", completed: false, partial: false });
    }
    if (/tool|search|weather/i.test(said)) {
      pushEvent(run, { event: "tool.started", tool: "web_search", preview: "weather today" });
      await sleep(t * 2);
      pushEvent(run, { event: "tool.completed", tool: "web_search", duration: 0.42, error: false, preview: "Sunny, 64°F" });
      addMessage(run.session_id, { role: "tool", content: "Sunny, 64°F", tool_name: "web_search" });
    }
    if (/subagent|delegate/i.test(said)) {
      pushEvent(run, { event: "subagent.start", subagent_id: "sa_1", goal: "Research options" });
      await sleep(t * 2);
      pushEvent(run, { event: "subagent.complete", subagent_id: "sa_1", goal: "Research options", status: "completed", summary: "Found 3 options" });
    }
    if (/approv|delete|rm /i.test(said)) {
      const request_id = hex(16);
      run.status = "waiting_for_approval";
      run.approval = {
        event: "approval.request",
        command: "rm -rf build",
        pattern_key: "rm_recursive",
        pattern_keys: ["rm_recursive"],
        description: "Recursive delete",
        allow_permanent: true,
        allow_session: true,
        request_id,
        choices: ["once", "session", "always", "deny"],
      };
      pushEvent(run, run.approval);
      const choice = await new Promise((resolve) => (run.approvalResolver = resolve));
      if (run.status === "stopping" || run.status === "cancelled") return;
      run.status = "running";
      delete run.approval;
      pushEvent(run, { event: "approval.responded", choice, request_id, resolved: 1 });
      if (choice === "deny") {
        pushEvent(run, { event: "tool.completed", tool: "terminal", duration: 0, error: true, preview: "BLOCKED: denied by user" });
      } else {
        pushEvent(run, { event: "tool.started", tool: "terminal", preview: "rm -rf build" });
        await sleep(t);
        pushEvent(run, { event: "tool.completed", tool: "terminal", duration: 0.1, error: false, preview: "" });
      }
    }
    const slow = /slow|long/i.test(said);
    const reply = slow ? "Working through this step by step. ".repeat(12).trim() : `Got it: "${said.slice(0, 60)}". Here's what I found.`;
    const words = reply.split(/(?<= )/);
    for (const w of words) {
      if (run.status === "stopping") {
        await sleep(t);
        return finish(run, "cancelled", {
          completed: false,
          partial: true,
          interrupted: true,
          turn_exit_reason: "interrupted_by_user",
          pending_steer: run.pendingSteer ?? undefined,
        });
      }
      pushEvent(run, { event: "message.delta", delta: w });
      await sleep(slow ? t * 1.5 : Math.max(10, t / 4));
    }
    if (run.pendingSteer) {
      pushEvent(run, { event: "message.delta", delta: ` (Adjusted for: ${run.pendingSteer})` });
      run.pendingSteer = null;
    }
    const output = reply;
    addMessage(run.session_id, { role: "assistant", content: output, finish_reason: "stop" });
    if (/drop|disconnect/i.test(said)) {
      // Simulate the stream dying before the terminal event is delivered.
      for (const end of run.enders) end();
      run.enders = [];
      await sleep(t * 4);
    }
    finish(run, "completed", {
      completed: true,
      partial: false,
      interrupted: false,
      output,
      usage: { input_tokens: 10, output_tokens: words.length, total_tokens: 10 + words.length },
    });
  }

  function runStatus(run) {
    const { events, subscribers, enders, approvalResolver, speed, pendingSteer, ...rest } = run;
    return {
      object: "hermes.run",
      ...rest,
      ...(run.status === "waiting_for_approval" && run.approval ? { approval: run.approval } : {}),
      ...(pendingSteer ? { pending_steer: pendingSteer } : {}),
    };
  }

  async function handle(req, res, path, url, control) {
    if (path === "/health" || path === "/v1/health") {
      return json(res, 200, { status: "ok", platform: "hermes-agent", version: "v2026.9.24-mock" });
    }
    if (control.fail.has("hermes")) return json(res, 503, { error: { message: "Mock outage", type: "server_error", code: "gateway_draining" } });
    if (!bearerOk(req, apiKey)) {
      return json(res, 401, { error: { message: "Invalid gateway API key (API_SERVER_KEY)", type: "gateway_auth_error", code: "gateway_auth_failed" } });
    }
    const m = req.method;
    let match;

    if (path === "/v1/capabilities" && m === "GET") {
      return json(res, 200, {
        object: "hermes.api_server.capabilities",
        platform: "hermes-agent",
        model: "hermes-agent",
        auth: { type: "bearer", required: true },
        features: {
          run_submission: true,
          runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
          run_status: true,
          run_events_sse: true,
          run_stop: true,
          run_steer: true,
          run_approval_response: true,
          approval_events: true,
          session_fork: true,
          skills_api: true,
          jobs_admin: false,
          memory_write_api: false,
        },
        endpoints: {
          runs: { method: "POST", path: "/v1/runs" },
          run_events: { method: "GET", path: "/v1/runs/{run_id}/events" },
          sessions: { method: "GET", path: "/api/sessions" },
          session_fork: { method: "POST", path: "/api/sessions/{session_id}/fork" },
        },
      });
    }
    if (path === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: [{ id: "hermes-agent", object: "model", created: 1759200000, owned_by: "hermes", root: "hermes-agent", parent: null }],
      });
    }
    if (path === "/api/model/options") {
      return json(res, 200, {
        providers: [
          { id: "anthropic", name: "Anthropic" },
          { id: "openai", name: "OpenAI" },
        ],
        model: "claude-sonnet-4",
        provider: "anthropic",
      });
    }
    if (path === "/v1/skills") {
      return json(res, 200, {
        object: "list",
        data: [
          { name: "daily-compass", description: "Evening check-in", category: "life" },
          { name: "github-pr-workflow", description: "Open and iterate on PRs", category: "github" },
        ],
      });
    }
    if (path === "/v1/toolsets") {
      return json(res, 200, {
        object: "list",
        platform: "api_server",
        data: [
          { name: "web", label: "Web Search", description: "Search", enabled: true, configured: true, tools: ["web_search", "web_extract"] },
          { name: "terminal", label: "Terminal", enabled: true, configured: true, tools: ["terminal"] },
        ],
      });
    }
    if (path === "/api/jobs" && m === "GET") {
      return json(res, 200, {
        jobs: [
          {
            id: "a1b2c3d4e5f6",
            name: "Morning brief",
            prompt: "Summarize my inbox",
            schedule: { kind: "cron", expr: "0 7 * * *", display: "0 7 * * *" },
            schedule_display: "0 7 * * *",
            enabled: true,
            state: "scheduled",
            next_run_at: new Date(Date.now() + 36e5 * 10).toISOString(),
            last_run_at: new Date(Date.now() - 36e5 * 14).toISOString(),
            last_status: "ok",
            last_error: null,
            failure_streak: 0,
          },
          {
            id: "0f1e2d3c4b5a",
            name: "Backup check",
            prompt: "Verify backups",
            schedule_display: "every 6h",
            enabled: true,
            state: "scheduled",
            next_run_at: new Date(Date.now() + 36e5 * 2).toISOString(),
            last_run_at: new Date(Date.now() - 36e5 * 4).toISOString(),
            last_status: "error",
            last_error: "rsync exited 23",
            failure_streak: 2,
          },
        ],
      });
    }
    if ((match = path.match(/^\/api\/jobs\/([a-f0-9]{12})\/(pause|resume|run)$/)) && m === "POST") {
      return json(res, 200, { job: { id: match[1], name: "Job", enabled: match[2] !== "pause", state: match[2] === "pause" ? "paused" : "scheduled" } });
    }

    // Sessions
    if (path === "/api/sessions" && m === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const data = [...state.sessions.values()].sort((a, b) => b.last_active - a.last_active).slice(0, limit);
      return json(res, 200, { object: "list", data, limit, offset: 0, has_more: false });
    }
    if (path === "/api/sessions" && m === "POST") {
      const body = await readBody(req);
      if (body.id && state.sessions.has(body.id)) return hermesError(res, 409, "session_exists", "Session already exists");
      const s = addSession({ id: body.id ?? body.session_id, title: body.title, source: body.source });
      return json(res, 201, { object: "hermes.session", session: s });
    }
    if ((match = path.match(/^\/api\/sessions\/([^/]+)$/))) {
      const s = state.sessions.get(decodeURIComponent(match[1]));
      if (!s) return hermesError(res, 404, "session_not_found", "Session not found");
      if (m === "GET") return json(res, 200, { object: "hermes.session", session: s });
      if (m === "PATCH") {
        const body = await readBody(req);
        const allowed = ["title", "end_reason", "pinned", "archived", "hidden", "unread"];
        for (const k of Object.keys(body)) if (!allowed.includes(k)) return hermesError(res, 400, "unsupported_session_field", `Unsupported field ${k}`);
        if ("title" in body) s.title = body.title;
        for (const k of ["pinned", "archived", "hidden"]) if (k in body) s[k] = body[k];
        return json(res, 200, { object: "hermes.session", session: s });
      }
      if (m === "DELETE") {
        state.sessions.delete(s.id);
        return json(res, 200, { object: "hermes.session.deleted", id: s.id, deleted: true });
      }
    }
    if ((match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && m === "GET") {
      const id = decodeURIComponent(match[1]);
      if (!state.sessions.has(id)) return hermesError(res, 404, "session_not_found", "Session not found");
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 500)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const order = url.searchParams.get("order") || "latest";
      if (!["oldest", "latest"].includes(order)) return hermesError(res, 400, "invalid_pagination", "Invalid order");
      const all = state.messages.get(id);
      const end = Math.max(0, all.length - offset);
      const data = order === "oldest" ? all.slice(offset, offset + limit) : all.slice(Math.max(0, end - limit), end);
      return json(res, 200, { object: "list", session_id: id, data, pagination: { limit, offset, order, returned: data.length } });
    }
    if ((match = path.match(/^\/api\/sessions\/([^/]+)\/fork$/)) && m === "POST") {
      const id = decodeURIComponent(match[1]);
      const src = state.sessions.get(id);
      if (!src) return hermesError(res, 404, "session_not_found", "Session not found");
      const body = await readBody(req);
      const child = addSession({ id: body.id, title: body.title ?? `${src.title ?? "Session"} fork`, parent_session_id: id });
      for (const { id: _omit, ...msg } of state.messages.get(id)) addMessage(child.id, { ...msg, session_id: child.id });
      src.end_reason = "branched";
      src.ended_at = now();
      return json(res, 201, { object: "hermes.session", session: child });
    }

    // Runs
    if (path === "/v1/runs" && m === "POST") {
      const body = await readBody(req);
      if (!body.input) return json(res, 400, { error: { message: "Missing 'input' field", type: "invalid_request_error" } });
      const key = req.headers["idempotency-key"];
      if (key && state.idem.has(key)) {
        const prev = state.idem.get(key);
        if (prev.body !== JSON.stringify(body)) return hermesError(res, 409, "idempotency_key_conflict", "Idempotency key reused with different payload");
        const run = state.runs.get(prev.runId);
        res.setHeader("Idempotency-Replayed", "true");
        return json(res, 202, { run_id: run.run_id, status: run.status, replayed: true });
      }
      const sessionId = body.session_id ?? null;
      if (sessionId && !state.sessions.has(sessionId)) addSession({ id: sessionId });
      const run = {
        run_id: `run_${hex(16)}`,
        status: "queued",
        created_at: now(),
        updated_at: now(),
        session_id: sessionId,
        model: body.model ?? "hermes-agent",
        events: [],
        subscribers: new Set(),
        enders: [],
        speed: Number(url.searchParams.get("speed") ?? control.speed),
      };
      state.runs.set(run.run_id, run);
      if (key) state.idem.set(key, { runId: run.run_id, body: JSON.stringify(body) });
      const input = typeof body.input === "string" ? body.input : (body.input.at(-1)?.content ?? "");
      setTimeout(() => execute(run, input, body.instructions), 5);
      return json(res, 202, { run_id: run.run_id, status: "started", replayed: false });
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)$/)) && m === "GET") {
      const run = state.runs.get(match[1]);
      if (!run) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      return json(res, 200, runStatus(run));
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/events$/)) && m === "GET") {
      const run = state.runs.get(match[1]);
      if (!run) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": open\n\n");
      const last = req.headers["last-event-id"] ?? url.searchParams.get("last_seq");
      const from = last !== undefined && last !== null ? Number(last) + 1 : 0;
      const write = (e) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      for (const e of run.events.slice(from)) write(e);
      const terminal = ["completed", "failed", "cancelled", "interrupted"];
      const close = () => {
        run.subscribers.delete(write);
        try {
          res.write(": stream closed\n\n");
          res.end();
        } catch {}
      };
      if (terminal.includes(run.status) && run.events.at(-1)?.event?.startsWith("run.")) return close();
      run.subscribers.add(write);
      run.enders.push(close);
      req.on("close", () => run.subscribers.delete(write));
      return;
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/stop$/)) && m === "POST") {
      const run = state.runs.get(match[1]);
      if (!run) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return json(res, 200, runStatus(run));
      const wasWaiting = run.status === "waiting_for_approval";
      run.status = "stopping";
      if (wasWaiting) {
        setTimeout(() => finish(run, "cancelled", { completed: false, partial: false, interrupted: true }), run.speed);
        run.approvalResolver?.("deny");
      }
      return json(res, 200, { run_id: run.run_id, status: "stopping" });
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/approval$/)) && m === "POST") {
      const run = state.runs.get(match[1]);
      if (!run) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      const body = await readBody(req);
      const choice = { approve: "once", approved: "once", allow: "once" }[body.choice] ?? body.choice;
      if (!["once", "session", "always", "deny"].includes(choice)) return hermesError(res, 400, "invalid_approval_choice", "Invalid choice");
      if (!run.approvalResolver || run.status !== "waiting_for_approval") return hermesError(res, 409, "approval_not_pending", "No approval pending");
      const resolve = run.approvalResolver;
      run.approvalResolver = null;
      resolve(choice);
      return json(res, 200, { object: "hermes.run.approval_response", run_id: run.run_id, choice, request_id: body.request_id, resolved: 1 });
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/steer$/)) && m === "POST") {
      const run = state.runs.get(match[1]);
      if (!run) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      if (run.status !== "running") return hermesError(res, 409, "run_not_accepting_steer", "Run is not accepting steer");
      const body = await readBody(req);
      run.pendingSteer = body.input ?? body.message ?? body.text;
      pushEvent(run, { event: "run.steered", accepted: true });
      return json(res, 200, { object: "hermes.run.steer", run_id: run.run_id, accepted: true });
    }
    return notFound(res);
  }

  return { handle, reset: seed, state };
}
