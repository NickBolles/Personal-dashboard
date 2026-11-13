// Mock Hermes API Server — faithful to hermes-agent @ ddd0cc69 contracts
// (docs/research/hermes-api.md). Used for local dev, onboarding demos and E2E.
import { randomBytes } from "node:crypto";
import { json, readBody, bearerOk, notFound, hermesError, isoDateIn } from "./util.mjs";

const now = () => Date.now() / 1000;
const hex = (n) => randomBytes(n).toString("hex");

/** Named Hermes profiles served under /p/<profile>/ (gateway.multiplex_profiles), each with its own key. */
export const MOCK_PROFILE_KEYS = {
  momentumchief: "mock-hermes-momentumchief-key-0123456789",
  devchief: "mock-hermes-devchief-key-0123456789",
};

/** A transcript with Hermes control frames (formats from hermes tools/process_registry_notifications.py). */
const COORDINATOR_TRANSCRIPT = [
  { role: "user", content: "Compare the three vendor quotes and summarise." },
  {
    role: "user",
    content: [
      "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions.",
      "",
      "## Summary",
      "Owner asked for a vendor comparison; quotes from Acme, Birch and Cobalt were collected.",
    ].join("\n"),
  },
  {
    role: "user",
    content: [
      "[ASYNC DELEGATION BATCH COMPLETE — deleg_e2e1]",
      "A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished; its consolidated results are below.",
      "",
      "Dispatched: 2026-11-04 09:00:00 (4m ago)",
      "Role: leaf   Model: gpt-6.1-sol   Total duration: 241.5s",
      "",
      "--- ✓ TASK 1/2: Price the Acme quote  (status=completed, api_calls=12, 118.2s) ---",
      "Acme comes to $4,200/yr with support included.",
      "Full live transcript (complete tool/assistant trace): /opt/data/transcripts/deleg_e2e1-task1.jsonl",
      "",
      "--- ✗ TASK 2/2: Price the Birch quote  (status=failed, api_calls=3, 40.0s) ---",
      "(no summary — status=failed: vendor portal timed out)",
      "Full live transcript (complete tool/assistant trace): /opt/data/transcripts/deleg_e2e1-task2.jsonl",
    ].join("\n"),
  },
  {
    role: "user",
    content: "[IMPORTANT: Background process proc_e2e7 completed (exit code 0).\nCommand: npm run quotes:export\nOutput:\nwrote quotes.csv (3 rows)]",
  },
  { role: "assistant", content: "Acme is priced; Birch timed out, so I'll retry it.", finish_reason: "stop" },
];

export function createHermes({ apiKey }) {
  const state = {
    profileRequests: {},
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
    // Coordinator chat e2e: chats on the momentumchief profile that Jarvis didn't start (adopt flow),
    // its hidden Bot Chat inbox (never adoptable) and a sub-agent child. Profile-scoped, so they never
    // show in the default list other specs read.
    const nb = addSession({ id: "sess_mc_notices", title: "Quarterly vendor review", started_at: now() - 5400, last_active: now() - 1800 });
    nb.profile = "momentumchief";
    nb.source = "webui";
    for (const content of COORDINATOR_TRANSCRIPT) addMessage(nb.id, content);
    const bot = addSession({ id: "sess_mc_botchat", title: "Bot Chat", started_at: now() - 86400, last_active: now() - 600 });
    bot.profile = "momentumchief";
    bot.source = "webui";
    bot.hidden = true;
    const sub = addSession({
      id: "sess_mc_sub",
      title: "Subagent: compare vendor quotes",
      parent_session_id: nb.id,
      started_at: now() - 3000,
      last_active: now() - 2400,
    });
    sub.profile = "momentumchief";
    sub.source = "webui";
    addMessage(sub.id, { role: "assistant", content: "Vendor comparison results are retained here.", finish_reason: "stop" });
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

  /**
   * Ask for approval the way production Hermes does (session-authority run path): the
   * `approval.request` event and `GET /v1/runs/{id}` `pending_controls` carry `prompt_id` +
   * `execution_generation` (no `request_id`), and POST /approval must echo exactly
   * `{ choice, request_id: prompt_id, execution_generation }` (see the approval route below).
   */
  function askApproval(run, { command, description, choices }) {
    const prompt_id = hex(16);
    run.status = "waiting_for_approval";
    run.approval = { kind: "approval", prompt_id, execution_generation: run.execution_generation, command, ...(description ? { description } : {}), choices };
    pushEvent(run, { event: "approval.request", ...run.approval });
    return prompt_id;
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
    if (source === "workflow_draft") {
      // Save chat as workflow / Describe it: a proposal with one invalid-free set of parts.
      return JSON.stringify({
        basics: { name: "Lantern study notes", slug: "lantern", icon: "book-open", description: "Notes from the lantern study group", area: null },
        instructions: "Keep each passage, the questions we asked, and my own takeaways separate. Use my words.",
        capture: { session: { type: "object", fields: { leader: "text?", passage: "scripture_ref?" } }, takeaways: { type: "list", of: "text" } },
        startForm: {
          title: "Start lantern study",
          fields: [
            { id: "leader", bind: "session.leader", type: "person", label: "Leader" },
            { id: "passage", bind: "session.passage", type: "scripture", label: "Passage" },
          ],
        },
        rationale: "You repeat the same three-part structure every week.",
      });
    }
    if (source === "workflow_summary") {
      // End-of-session summary draft (W4): a proposal the owner accepts.
      return JSON.stringify({ summary: "Mock summary: remain in the vine; fruit follows." });
    }
    if (source === "workflow_reflection") {
      return JSON.stringify({ prompt: "Where will you stay connected this week?" });
    }
    if (source === "workflow_test_turn") {
      // Test a turn (sandbox): reply + proposed capture changes, nothing persisted.
      const said = input.match(/<message>\n([\s\S]*?)\n<\/message>/)?.[1]?.trim() ?? "";
      return JSON.stringify({
        reply: `Noted: ${said.slice(0, 80)}`,
        capture: [{ op: "add", path: "/takeaways/-", value: said.slice(0, 120) || "(empty)" }],
      });
    }
    return JSON.stringify({ error: `No tool for ${source}` });
  }

  /**
   * Jarvis AI jobs (JARVIS_AI_JOB kind=…): deterministic JSON per kind.
   * FORCE_ERROR / FORCE_PROSE / FORCE_APPROVAL / FORCE_SLOW / FORCE_COST=<usd>
   * in the task text change the behaviour; the session gets a cost.
   */
  function forcedDestination(input) {
    const want = input.match(/FORCE_DEST=(\S+)/)?.[1];
    if (!want) return null;
    for (const line of input.split("\n")) {
      const m = line.match(/^(\S+) — (.+)$/);
      if (m && m[2].trim().endsWith(want)) return m[1];
    }
    return null;
  }

  /**
   * Capture triage@2 actions for E2E, from the capture text inside the <data> block:
   * "add <x> to grocery" → Skylight list add on the shopping list; "dentist" → an appointment
   * without a time (needs input); "garage" → a device action (suggest only). Else no action.
   */
  function triageAction(input) {
    const data = (input.match(/<data[^>]*>([\s\S]*?)<\/data>/) || [])[1] || "";
    const lists = [...input.matchAll(/^(\S+) — (.+) \((\w+)\)$/gm)].map((m) => ({ id: m[1], label: m[2], kind: m[3] }));
    const add = data.match(/\badd ([a-z ]{1,40}?) to (?:the )?grocer(?:y|ies)\b/i);
    if (add) {
      const shop = lists.find((l) => l.kind === "shopping") || lists[0];
      const label = add[1].trim().replace(/^\w/, (c) => c.toUpperCase());
      return {
        type: "skylight_list_add",
        confidence: 0.93,
        summary: `Add “${label}” to ${shop ? shop.label : "the list"} on Skylight`,
        listId: shop ? shop.id : null,
        label,
      };
    }
    if (/\bdentist\b/i.test(data))
      return {
        type: "skylight_event_create",
        confidence: 0.88,
        summary: "Add the dentist appointment to the family calendar",
        event: { summary: "Dentist appointment", date: null, time: null },
        missing: ["date", "time"],
        question: null,
        choices: [],
      };
    if (/\bgarage\b/i.test(data)) return { type: "ha_device", confidence: 0.95, summary: "Open the garage door" };
    return null;
  }

  function aiJobAnswer(kind, input) {
    if (/FORCE_ERROR/.test(input)) return JSON.stringify({ error: "tool missing" });
    if (/FORCE_PROSE/.test(input)) return "Here is a prose answer instead of JSON.";
    const title = (input.match(/"([^"]{1,80})"/) || [])[1] || "this";
    const common = {
      title: `Findings: ${title}`.slice(0, 120),
      summary: `Three options for ${title}; the first one fits best.`,
      body_markdown: `## Overview\nOption A is the most mature [1]. Option B is cheaper [2].\n\n- **A**: proven\n- **B**: cheap`,
      sources: [
        { url: "https://example.com/option-a", title: "Option A docs", quote: "A is production ready" },
        { url: "https://example.org/option-b", title: "Option B pricing" },
        { url: "https://github.com/example/c", title: "Option C repo" },
      ],
      next_actions: [{ title: `Try option A for ${title}`.slice(0, 200), why: "Lowest risk" }],
      open_questions: ["Is the budget fixed?"],
      assumptions: ["Single user"],
      confidence: "medium",
    };
    switch (kind) {
      case "research":
        return JSON.stringify({
          ...common,
          options: [
            { name: "A", pros: ["proven"], cons: ["cost"], fit: "best" },
            { name: "B", pros: ["cheap"], cons: ["young"] },
          ],
          recommendation: "A",
        });
      case "plan":
        return JSON.stringify({
          ...common,
          steps: [
            { title: "Write the spec", detail: "One page" },
            { title: "Build a prototype", dependsOn: [0] },
            { title: "Measure it", dependsOn: [1] },
          ],
          acceptance: ["Prototype runs"],
          validation: { metric: "p95 latency", comparator: "<=", threshold: 800, unit: "ms" },
          risks: ["Scope creep"],
        });
      case "schedule":
        return JSON.stringify({ durationMinutes: 90, splitOk: false, preferredWindows: ["morning"], reason: "Needs focus; best done in the morning." });
      case "draft":
        return JSON.stringify({
          ...common,
          title: "Draft",
          subject: `About ${title}`,
          body_markdown: `Hi,\n\nQuick note about ${title}.\n\nThanks,\nNick`,
          variants: [],
          notes: "Short and direct",
        });
      case "triage":
        return JSON.stringify({
          title: `Look into ${title}`.slice(0, 120),
          kind: "task",
          // FORCE_DEST=<title>: suggest the destination whose path ends with that title.
          destinationKey: forcedDestination(input),
          confidence: 0.82,
          reason: "Looks actionable",
          shouldInvestigate: true,
          brief: "Find the key facts",
          sensitivity: "none",
          action: triageAction(input),
        });
      default:
        return JSON.stringify(common);
    }
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
    if (input.includes("SCHEDULED_PROPOSALS") || input.includes("SCHEDULED_SILENT")) {
      const output = input.includes("SCHEDULED_SILENT")
        ? "NOTHING_NEW"
        : 'Morning brief: one capture is waiting and one project looks blocked.\n\n```jarvis-proposals\n[{"intent":"create_note","title":"Lantern check-in note","text":"Two captures look like they belong here.","why":"Overnight triage"},{"intent":"update_status","title":"Mark blocked","why":"No movement in 9 days"},{"intent":"deploy","why":"Ship it"}]\n```';
      addMessage(run.session_id, { role: "assistant", content: output, finish_reason: "stop" });
      return finish(run, "completed", { completed: true, partial: false, interrupted: false, output });
    }
    const structured = typeof instructions === "string" ? instructions.match(/JARVIS_STRUCTURED_REQUEST source=(\w+)/)?.[1] : undefined;
    const aiKind = typeof instructions === "string" ? instructions.match(/JARVIS_AI_JOB kind=(\w+)/)?.[1] : undefined;
    if (aiKind) {
      const s = state.sessions.get(run.session_id);
      const cost = Number(input.match(/FORCE_COST=([\d.]+)/)?.[1] ?? (aiKind === "triage" || aiKind === "schedule" ? 0.004 : 0.12));
      if (s) s.estimated_cost_usd = cost;
      if (/FORCE_APPROVAL/.test(input)) {
        run.status = "waiting_for_approval";
        askApproval(run, { command: "rm -rf build", choices: ["once", "deny"] });
        await new Promise((resolve) => (run.approvalResolver = resolve));
        return;
      }
      if (/FORCE_SLOW|FORCE_COST/.test(input)) {
        while (run.status !== "stopping") await sleep(t);
        return finish(run, "cancelled", { completed: false, partial: true, interrupted: true });
      }
      await sleep(t * 2);
      const output = input.startsWith("Reply again") ? "{}" : aiJobAnswer(aiKind, input);
      addMessage(run.session_id, { role: "assistant", content: output, finish_reason: "stop" });
      return finish(run, "completed", {
        completed: true,
        partial: false,
        interrupted: false,
        output,
        usage: { input_tokens: 900, output_tokens: 400, total_tokens: 1300 },
      });
    }
    if (structured) {
      state.structuredCount++;
      if (/FORCE_APPROVAL/.test(input)) {
        run.status = "waiting_for_approval";
        askApproval(run, { command: "skylight write", choices: ["once", "deny"] });
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
      const child = addSession({ id: `child_${run.run_id}`, title: "Subagent: Research options", source: "subagent", parent_session_id: run.session_id });
      child.profile = state.sessions.get(run.session_id)?.profile;
      const identity = {
        subagent_id: `sa_${run.run_id}`,
        child_session_id: child.id,
        delegation_id: `deleg_${run.run_id}`,
        parent_id: null,
        task_index: 0,
        task_count: 1,
      };
      pushEvent(run, { event: "subagent.start", ...identity, goal: "Research options" });
      await sleep(t * 2);
      addMessage(child.id, { role: "assistant", content: "Found 3 options", finish_reason: "stop" });
      pushEvent(run, {
        event: "subagent.complete",
        ...identity,
        goal: "Research options",
        status: "completed",
        summary: "Found 3 options",
        duration_seconds: 0.2,
      });
    }
    if (/clarif/i.test(said)) {
      // Session-authority clarify (gateway/session_pending_controls.py register_clarify): the run stays
      // "running"; the prompt is in `clarify.request` and GET pending_controls until answered.
      const prompt_id = hex(16);
      run.clarify = {
        kind: "clarify",
        prompt_id,
        execution_generation: run.execution_generation,
        question: "Which colour should the dashboard accent be?",
        choices: ["Teal", "Amber", "Violet"],
        multi_select: false,
        timeout_s: 600,
      };
      pushEvent(run, { event: "clarify.request", ...run.clarify });
      const answer = await new Promise((resolve) => (run.clarifyResolver = resolve));
      delete run.clarify;
      if (run.status === "stopping") return finish(run, "cancelled", { completed: false, partial: false, interrupted: true });
      if (run.status === "cancelled") return;
      pushEvent(run, { event: "clarify.settled", prompt_id, execution_generation: run.execution_generation });
      run.clarifyAnswer = answer;
    }
    if (/approv|delete|rm /i.test(said)) {
      run.status = "waiting_for_approval";
      const prompt_id = askApproval(run, { command: "rm -rf build", description: "Recursive delete", choices: ["once", "session", "always", "deny"] });
      const choice = await new Promise((resolve) => (run.approvalResolver = resolve));
      if (run.status === "stopping" || run.status === "cancelled") return;
      run.status = "running";
      delete run.approval;
      pushEvent(run, { event: "approval.settled", prompt_id, execution_generation: run.execution_generation });
      if (choice === "deny") {
        pushEvent(run, { event: "tool.completed", tool: "terminal", duration: 0, error: true, preview: "BLOCKED: denied by user" });
      } else {
        pushEvent(run, { event: "tool.started", tool: "terminal", preview: "rm -rf build" });
        await sleep(t);
        pushEvent(run, { event: "tool.completed", tool: "terminal", duration: 0.1, error: false, preview: "" });
        // Like real Hermes, the tool call lands in history (else the summary vanishes once history replaces live rows).
        addMessage(run.session_id, { role: "tool", content: "", tool_name: "terminal" });
      }
    }
    const slow = /slow|long/i.test(said) && !/FORCE_STREAM_LONG/.test(said);
    let reply = run.clarifyAnswer
      ? `Going with ${run.clarifyAnswer}.`
      : slow
        ? "Working through this step by step. ".repeat(12).trim()
        : `Got it: "${said.slice(0, 60)}". Here's what I found.`;
    // Streaming/scroll perf harness: a long markdown reply (~1.5k words) streamed word by word.
    if (/FORCE_STREAM_LONG/.test(said))
      reply = Array.from(
        { length: 24 },
        (_, i) =>
          `### Step ${i + 1}\n\nWorking through part ${i + 1} of the plan, checking each file and noting what changed so the summary stays honest.\n\n` +
          `- first check for part ${i + 1}\n- second check with a longer line that wraps on a phone screen\n- third check\n`,
      ).join("\n");
    // Links panel e2e: a reply that shares an artifact (view + asset URL = one row).
    if (/\[mock: (\d+) image\(s\)\]/.test(input)) reply = `I can see ${input.match(/\[mock: (\d+) image\(s\)\]/)[1]} picture(s).`;
    else if (/share the zephyr board/i.test(said))
      reply = "Published: https://artifacts.ai.nickbolles.com/v/zephyr-board-e2e/ (hero: https://artifacts.ai.nickbolles.com/a/zephyr-board-e2e/hero.png).";
    // Workflow runs (jarvis-capture@1): file a quote into the live outline.
    if (`${typeof instructions === "string" ? instructions : ""}\n${input}`.includes("jarvis-capture@1") && /quote this/i.test(said)) {
      const ops = [{ op: "add", path: "/quotes/-", value: { text: "Remain in me, as I also remain in you", who: "Jake Fry" } }];
      reply = `Filed the quote.\n\n\`\`\`jarvis-capture\n${JSON.stringify(ops)}\n\`\`\``;
    }
    // Smart replies (jarvis-ui@1): a triage block built from the refs Jarvis attached.
    if (typeof instructions === "string" && instructions.includes("jarvis-ui@1") && /triage/i.test(said)) {
      const refs = [...input.matchAll(/^(todo:[^\s|]+) \| /gm)].map((m) => m[1]);
      const later = isoDateIn(10);
      const bucket = (k) => refs.filter((_, i) => i % 3 === k);
      const list = (key, title, b, extra) => ({
        type: "TaskList",
        props: { title, bucket: b, rows: bucket(key).map((ref) => ({ ref, suggestion: b, ...extra })) },
      });
      const elements = { r: { type: "Stack", props: {}, children: [] } };
      for (const [k, title, b, extra] of [
        [0, "Do this week", "do_week", {}],
        [1, "Reschedule", "reschedule", { suggestedDate: later }],
        [2, "Drop", "drop", { reason: "Not worth it now" }],
      ])
        if (bucket(k).length) {
          elements[`l${k}`] = list(k, title, b, extra);
          elements.r.children.push(`l${k}`);
        }
      const spec = { v: 1, catalog: "jarvis-ui@1", root: "r", elements };
      reply = `Here's a pass on ${refs.length} overdue todos. Nothing changes until you apply.\n\n\`\`\`jarvis-ui\n${JSON.stringify(spec)}\n\`\`\``;
    }
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
    const { events, subscribers, enders, approvalResolver, clarifyResolver, speed, pendingSteer, approval, clarify, ...rest } = run;
    return {
      object: "hermes.run",
      ...rest,
      // Session-authority projection: no `approval` field; pending prompts live in `pending_controls`.
      // A clarify question keeps the run "running" (api_server_authority_runs.py run_projection).
      pending_controls: [...(run.status === "waiting_for_approval" && run.approval ? [run.approval] : []), ...(run.clarify ? [run.clarify] : [])],
      ...(pendingSteer ? { pending_steer: pendingSteer } : {}),
    };
  }

  async function handle(req, res, rawPath, url, control) {
    // /p/<profile>/… selects a named profile; unknown prefixes 404 and a profile never accepts the default key.
    let path = rawPath;
    let profile = null;
    const pm = rawPath.match(/^\/p\/([a-z0-9][a-z0-9_-]*)(\/.*)?$/);
    if (pm) {
      profile = pm[1];
      path = pm[2] ?? "/";
      if (!(profile in MOCK_PROFILE_KEYS)) return json(res, 404, { error: "Unknown or unconfigured profile" });
    }
    // Sessions and runs live in their profile's own store.
    const mine = (o) => o && (o.profile ?? null) === profile;
    if (path === "/health" || path === "/v1/health") {
      return json(res, 200, { status: "ok", platform: "hermes-agent", version: "v2026.9.24-mock" });
    }
    const busy = control.hermesBusy;
    if (busy && busy.count > 0 && (!busy.method || busy.method === req.method) && (!busy.path || busy.path === path)) {
      busy.count--;
      busy.hits++;
      res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
      return res.end("max connections reached: 10");
    }
    if (control.fail.has("hermes")) return json(res, 503, { error: { message: "Mock outage", type: "server_error", code: "gateway_draining" } });
    if (!bearerOk(req, profile ? MOCK_PROFILE_KEYS[profile] : apiKey)) {
      return json(res, 401, { error: { message: "Invalid gateway API key (API_SERVER_KEY)", type: "gateway_auth_error", code: "gateway_auth_failed" } });
    }
    const m = req.method;
    let match;
    if (profile) state.profileRequests[profile] = (state.profileRequests[profile] ?? 0) + 1;

    // Demo/UX seeding hook (scripts/demo-seed-coordinator.mjs): create or replace whole sessions with an
    // exact transcript (roles, tool calls, timestamps). Additive: Jarvis and the tests never call it, and
    // /__mock/reset still clears everything. Under /p/<profile>/ the sessions land on that profile's store.
    if (path === "/__mock/seed" && m === "POST") {
      const body = await readBody(req);
      const seeded = [];
      for (const s of [].concat(body.sessions ?? [])) {
        if (!s || typeof s.id !== "string" || !s.id) continue;
        const prior = state.sessions.get(s.id);
        if (prior && !mine(prior)) continue; // never touch another profile's session
        const session = addSession({
          id: s.id,
          title: s.title,
          source: s.source,
          model: s.model,
          parent_session_id: s.parent_session_id,
          started_at: s.started_at,
        });
        if (profile) session.profile = profile;
        // `timestamp` (unix seconds) on a message overrides "now"; last_active follows the last message.
        for (const msg of [].concat(s.messages ?? [])) if (msg && typeof msg.role === "string") addMessage(session.id, msg);
        session.tool_call_count = state.messages.get(session.id).filter((x) => x.role === "tool").length;
        for (const k of ["last_active", "ended_at", "end_reason", "pinned", "archived", "hidden", "preview"]) if (k in s) session[k] = s[k];
        seeded.push({ id: session.id, message_count: session.message_count });
      }
      return json(res, 200, { object: "hermes.mock.seed", seeded });
    }

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
      const data = [...state.sessions.values()]
        .filter(mine)
        .sort((a, b) => b.last_active - a.last_active)
        .slice(0, limit);
      return json(res, 200, { object: "list", data, limit, offset: 0, has_more: false });
    }
    if (path === "/api/sessions" && m === "POST") {
      const body = await readBody(req);
      if (body.id && state.sessions.has(body.id)) return hermesError(res, 409, "session_exists", "Session already exists");
      const s = addSession({ id: body.id ?? body.session_id, title: body.title, source: body.source });
      if (profile) s.profile = profile;
      return json(res, 201, { object: "hermes.session", session: s });
    }
    if ((match = path.match(/^\/api\/sessions\/([^/]+)$/))) {
      const s = state.sessions.get(decodeURIComponent(match[1]));
      if (!mine(s)) return hermesError(res, 404, "session_not_found", "Session not found");
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
      if (!mine(state.sessions.get(id))) return hermesError(res, 404, "session_not_found", "Session not found");
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
      if (!mine(src)) return hermesError(res, 404, "session_not_found", "Session not found");
      const body = await readBody(req);
      const child = addSession({ id: body.id, title: body.title ?? `${src.title ?? "Session"} fork`, parent_session_id: id });
      if (profile) child.profile = profile;
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
      if (sessionId && state.sessions.has(sessionId) && !mine(state.sessions.get(sessionId)))
        return hermesError(res, 409, "session_profile_mismatch", "Session lives on another profile");
      if (sessionId && !state.sessions.has(sessionId)) {
        const s = addSession({ id: sessionId });
        if (profile) s.profile = profile;
      }
      const run = {
        run_id: `run_${hex(16)}`,
        status: "queued",
        created_at: now(),
        updated_at: now(),
        session_id: sessionId,
        model: body.model ?? "hermes-agent",
        profile,
        execution_generation: 1,
        events: [],
        subscribers: new Set(),
        enders: [],
        speed: Number(url.searchParams.get("speed") ?? control.speed),
      };
      state.runs.set(run.run_id, run);
      if (key) state.idem.set(key, { runId: run.run_id, body: JSON.stringify(body) });
      // Like Hermes /v1/runs: a string, or a messages list whose last content may be text + image_url parts.
      const content = typeof body.input === "string" ? body.input : (body.input.at(-1)?.content ?? "");
      let input = content;
      if (Array.isArray(content)) {
        let images = 0;
        const texts = [];
        for (const p of content) {
          const t = String(p?.type ?? "").toLowerCase();
          if (t === "text" || t === "input_text") texts.push(String(p.text ?? ""));
          else if (t === "image_url" || t === "input_image") {
            const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
            if (!/^(https?:|data:image\/)/.test(String(u ?? ""))) return hermesError(res, 400, "invalid_image_url", "image_url must be http(s) or data:image/");
            images++;
          } else return hermesError(res, 400, "unsupported_content_type", "Only text and image_url/input_image parts are supported.");
        }
        input = texts.join("\n") + (images ? `\n[mock: ${images} image(s)]` : "");
        state.lastImages = images;
      }
      setTimeout(() => execute(run, input, body.instructions), 5);
      return json(res, 202, { run_id: run.run_id, status: "started", replayed: false });
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)$/)) && m === "GET") {
      const run = state.runs.get(match[1]);
      if (!run || (run.profile ?? null) !== profile) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      return json(res, 200, runStatus(run));
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/events$/)) && m === "GET") {
      const run = state.runs.get(match[1]);
      if (!run || (run.profile ?? null) !== profile) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
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
      if (!run || (run.profile ?? null) !== profile) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return json(res, 200, runStatus(run));
      const wasWaiting = run.status === "waiting_for_approval";
      run.status = "stopping";
      if (wasWaiting) {
        setTimeout(() => finish(run, "cancelled", { completed: false, partial: false, interrupted: true }), run.speed);
        run.approvalResolver?.("deny");
      }
      run.clarifyResolver?.("");
      return json(res, 200, { run_id: run.run_id, status: "stopping" });
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/approval$/)) && m === "POST") {
      const run = state.runs.get(match[1]);
      if (!run || (run.profile ?? null) !== profile) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      const body = await readBody(req);
      // Mirrors gateway/platforms/api_server_authority_runs.py respond_run + session_pending_controls.py:
      // the key set must be EXACTLY these three (else 400 invalid_params, which is what production
      // returned when Jarvis sent `{ choice, request_id }`), the generation must match, and the
      // choice must be one the prompt offered.
      const keys = Object.keys(body ?? {})
        .sort()
        .join(",");
      if (keys !== "choice,execution_generation,request_id") return hermesError(res, 400, "invalid_params", "invalid_params");
      if (!Number.isInteger(body.execution_generation) || body.execution_generation !== run.execution_generation || run.status !== "waiting_for_approval")
        return hermesError(res, 409, "stale_generation", "stale_generation");
      if (!run.approval || !run.approvalResolver || run.approval.prompt_id !== body.request_id)
        return hermesError(res, 409, "approval_not_pending", "approval_not_pending");
      if (!run.approval.choices.includes(body.choice)) return hermesError(res, 400, "invalid_params", "invalid_params");
      const resolve = run.approvalResolver;
      run.approvalResolver = null;
      resolve(body.choice);
      return json(res, 200, { status: "resolved", prompt_id: body.request_id });
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/clarify$/)) && m === "POST") {
      const run = state.runs.get(match[1]);
      if (!run || (run.profile ?? null) !== profile) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
      const body = await readBody(req);
      // Mirrors api_server_authority_runs.py respond_run (kind=clarify): EXACTLY these three keys
      // (else 400 invalid_params), matching generation, a pending clarify prompt, a string answer ≤ 16384.
      const keys = Object.keys(body ?? {})
        .sort()
        .join(",");
      if (keys !== "answer,execution_generation,request_id") return hermesError(res, 400, "invalid_params", "invalid_params");
      if (!Number.isInteger(body.execution_generation) || body.execution_generation !== run.execution_generation || run.status !== "running")
        return hermesError(res, 409, "stale_generation", "stale_generation");
      if (!run.clarify || !run.clarifyResolver || run.clarify.prompt_id !== body.request_id)
        return hermesError(res, 409, "approval_not_pending", "approval_not_pending");
      if (typeof body.answer !== "string" || body.answer.length > 16384) return hermesError(res, 400, "invalid_params", "invalid_params");
      const resolve = run.clarifyResolver;
      run.clarifyResolver = null;
      resolve(body.answer);
      return json(res, 200, { run_id: run.run_id, status: "resolved", prompt_id: body.request_id });
    }
    if ((match = path.match(/^\/v1\/runs\/([^/]+)\/steer$/)) && m === "POST") {
      const run = state.runs.get(match[1]);
      if (!run || (run.profile ?? null) !== profile) return hermesError(res, 404, "run_not_found", `Run not found: ${match[1]}`);
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
