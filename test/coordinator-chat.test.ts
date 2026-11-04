import { describe, expect, it } from "vitest";
import { parseNotice, isNoticeText } from "@/lib/chat-notices";
import { foldSubagents, isSubagentSession } from "@/lib/session-children";
import { adoptRefusal, clarifyBody, pendingClarifyPrompt } from "@/integrations/hermes/service";
import { normalizeClarify, normalizeRunEvent } from "@/integrations/hermes/normalize";
import { reduceRun } from "@/components/chat/useRunStream";

// Exact text shapes from hermes tools/process_registry_notifications.py (_format_batch_delegation etc.).
const BATCH = [
  "[ASYNC DELEGATION BATCH COMPLETE — deleg_ab12]",
  "A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished; its consolidated results are below.",
  "",
  "Dispatched: 2026-11-04 09:00:00 (4m ago)",
  "Role: leaf   Model: gpt-6.1-sol   Total duration: 241.5s",
  "",
  "--- ✓ TASK 1/2: Price the Acme quote  (status=completed, api_calls=12, 118.2s) ---",
  "Acme comes to $4,200/yr.",
  "Second line of summary.",
  "Full live transcript (complete tool/assistant trace): /opt/data/t/task1.jsonl",
  "",
  "--- ✗ TASK 2/2: Price the Birch quote  (status=failed, api_calls=3, 40.0s) ---",
  "(no summary — status=failed: vendor portal timed out)",
  "Full live transcript (complete tool/assistant trace): /opt/data/t/task2.jsonl",
].join("\n");

describe("chat notices", () => {
  it("parses an async delegation batch into tasks with status, duration and transcript paths", () => {
    const n = parseNotice(BATCH);
    expect(n?.kind).toBe("delegation");
    if (n?.kind !== "delegation") return;
    expect(n.id).toBe("deleg_ab12");
    expect(n.status).toBe("partial");
    expect(n.duration).toBe("241.5s");
    expect(n.title).toBe("2 subagents finished (some failed)");
    expect(n.tasks).toHaveLength(2);
    expect(n.tasks[0]).toMatchObject({
      index: 1,
      total: 2,
      goal: "Price the Acme quote",
      status: "completed",
      ok: true,
      duration: "118.2s",
      transcript: "/opt/data/t/task1.jsonl",
    });
    expect(n.tasks[0]!.body).toBe("Acme comes to $4,200/yr.\nSecond line of summary.");
    expect(n.tasks[1]).toMatchObject({ ok: false, status: "failed", transcript: "/opt/data/t/task2.jsonl" });
  });

  it("parses a single-task completion and a task-failure early warning", () => {
    const single = [
      "[ASYNC DELEGATION COMPLETE — deleg_9]",
      "A background subagent you dispatched earlier has finished.",
      "",
      "Original goal: Draft the release notes",
      "Role: leaf   Model: ?",
      "Status: completed   API calls: 4   Duration: 30.2s",
      "Notes drafted in docs/release.md",
      "Full live transcript (complete tool/assistant trace): /x/y.jsonl",
    ].join("\n");
    const a = parseNotice(single);
    expect(a).toMatchObject({ kind: "delegation", status: "completed", title: "Subagent finished" });
    if (a?.kind === "delegation") expect(a.tasks[0]).toMatchObject({ goal: "Draft the release notes", ok: true, transcript: "/x/y.jsonl" });
    const failed = [
      "[ASYNC DELEGATION TASK FAILED — deleg_9, task 2/3]",
      "One subagent failed.",
      "Task: Check CI",
      "Status: failed   Duration: 5s\nError: boom",
      "Live transcript: /x/z.jsonl",
    ].join("\n");
    const b = parseNotice(failed);
    expect(b).toMatchObject({ kind: "delegation", status: "failed", title: "Subagent task 2/3 failed" });
    if (b?.kind === "delegation") expect(b.tasks[0]).toMatchObject({ goal: "Check CI", body: "boom", transcript: "/x/z.jsonl" });
  });

  it("parses background-process notices", () => {
    const done = parseNotice("[IMPORTANT: Background process proc_1 completed (exit code 0).\nCommand: npm test\nOutput:\nall green]");
    expect(done).toMatchObject({ kind: "process", ok: true, id: "proc_1", status: "exit 0", command: "npm test", output: "all green" });
    const bad = parseNotice("[IMPORTANT: Background process proc_2 exited (exit code 1, SIGTERM).\nCommand: x\nOutput:\nnope]");
    expect(bad).toMatchObject({ kind: "process", ok: false, title: "Background process failed" });
    const multi = parseNotice(
      "[IMPORTANT: 2 background processes completed. Treat these results as one batch.]\n\n[IMPORTANT: Background process a completed (exit code 0).\nCommand: a\nOutput:\nok]\n\n[IMPORTANT: Background process b completed (exit code 2).\nCommand: b\nOutput:\nno]",
    );
    expect(multi).toMatchObject({ kind: "process", title: "2 background processes finished", ok: false });
  });

  it("unwraps steers and compaction handoffs; ignores ordinary text", () => {
    const steer = parseNotice(
      "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\nUse the blue one\n[/OUT-OF-BAND USER MESSAGE]",
    );
    expect(steer).toEqual({ kind: "steer", text: "Use the blue one" });
    const c = parseNotice("[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.\n\n## Summary\nThings happened.");
    expect(c).toEqual({ kind: "compaction", summary: "## Summary\nThings happened." });
    expect(parseNotice("Hello [ASYNC DELEGATION BATCH COMPLETE — x]")).toBeNull();
    expect(isNoticeText("What's on my plate?")).toBe(false);
  });
});

describe("sub-agent sessions", () => {
  it("folds Hermes delegate_task children under their parent, keeps Jarvis forks", () => {
    const list: { id: string; title: string; parentSessionId?: string; source?: string; subagentCount?: number }[] = [
      { id: "p", title: "Parent", source: "webui" },
      { id: "c1", title: "Subagent: compare quotes", parentSessionId: "p", source: "webui" },
      { id: "c2", title: "Deep dive", parentSessionId: "p", source: "subagent" },
      { id: "orphan", title: "Subagent: x", parentSessionId: "gone", source: "webui" },
      { id: "fork", title: "Parent (fork)", parentSessionId: "p", source: "api_server" },
    ];
    expect(isSubagentSession(list[4]!)).toBe(false);
    const out = foldSubagents(list);
    expect(out.map((s) => s.id)).toEqual(["p", "fork"]);
    expect(out[0]!.subagentCount).toBe(2);
  });
});

describe("adopt", () => {
  it("refuses Bot Chat, hidden, sync and sub-agent sessions", () => {
    expect(adoptRefusal({ title: "Bot Chat" })).toBe("bot_chat");
    expect(adoptRefusal({ title: " bot chat " })).toBe("bot_chat");
    expect(adoptRefusal({ title: "Plans", hidden: true })).toBe("hidden");
    expect(adoptRefusal({ title: "Subagent: x", parentSessionId: "p", source: "webui" })).toBe("subagent");
    expect(adoptRefusal({ title: "Quarterly vendor review", source: "webui" })).toBeNull();
  });
});

describe("clarify (Hermes session-authority contract)", () => {
  // gateway/session_pending_controls.py register_clarify → pending_controls entry / clarify.request event.
  const prompt = {
    kind: "clarify",
    prompt_id: "pq1",
    execution_generation: 3,
    question: "Which colour?",
    choices: ["Teal", "Amber"],
    multi_select: false,
    timeout_s: 600,
  };
  const status = { execution_generation: 3, pending_controls: [{ kind: "approval", prompt_id: "ap1", execution_generation: 3 }, prompt] };

  it("builds EXACTLY { answer, request_id, execution_generation } (api_server_authority_runs.py respond_run)", () => {
    const body = clarifyBody(status, "Teal", "pq1");
    expect(body).toEqual({ answer: "Teal", request_id: "pq1", execution_generation: 3 });
    expect(Object.keys(body!).sort()).toEqual(["answer", "execution_generation", "request_id"]);
  });

  it("refuses a missing/replaced prompt, a legacy run, an empty or oversized answer", () => {
    expect(clarifyBody(status, "Teal", "other")).toBeNull();
    expect(clarifyBody({ pending_controls: [prompt] }, "Teal", "pq1")).toBeNull();
    expect(clarifyBody(status, "  ", "pq1")).toBeNull();
    expect(clarifyBody(status, "x".repeat(16385), "pq1")).toBeNull();
    expect(pendingClarifyPrompt(status)?.prompt_id).toBe("pq1");
  });

  it("normalizes clarify.request / clarify.settled events and drives the run state", () => {
    expect(normalizeClarify(prompt)).toEqual({ requestId: "pq1", question: "Which colour?", choices: ["Teal", "Amber"], multiSelect: undefined });
    const req = normalizeRunEvent({ event: "clarify.request", ...prompt, seq: 4, timestamp: 1 });
    expect(req.type).toBe("clarify.requested");
    const settled = normalizeRunEvent({ event: "clarify.settled", prompt_id: "pq1", execution_generation: 3, seq: 5, timestamp: 2 });
    expect(settled).toMatchObject({ type: "clarify.resolved", requestId: "pq1" });
    let s = reduceRun({ phase: "running", text: "", reasoning: "", activity: [], steerQueued: 0, attempts: 0 }, { type: "event", event: req });
    expect(s.clarify?.requestId).toBe("pq1");
    expect(s.phase).toBe("running");
    s = reduceRun(s, { type: "event", event: settled });
    expect(s.clarify).toBeUndefined();
  });
});
