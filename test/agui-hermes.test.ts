/**
 * Coordinators C1: Hermes → AG-UI adapter against RECORDED Hermes payloads
 * (test/fixtures/hermes/*.sse, captured from a live Hermes /v1/runs stream on
 * 2026-10-28: a terminal tool call, and a blocking approval that was denied).
 * Every event must pass @ag-ui/core's schemas and @ag-ui/client's protocol
 * verifier, and the browser must end up in the same state as the Jarvis format.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventSchemas } from "@ag-ui/core/schemas";
import { EventType, type AGUIEvent, type BaseEvent } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { SseParser } from "@/lib/sse";
import { normalizeRunEvent } from "@/integrations/hermes/normalize";
import { runEventSchema } from "@/integrations/hermes/types";
import { APPROVAL_TOOL, HERMES_APPROVAL_TIMEOUT_S, HermesAguiTranslator, STREAM_CLOSED, approvalChoiceFromResume } from "@/server/agui/hermes";
import { aguiToRunEvents, isAguiEvent, newAguiReadState } from "@/lib/agui/reducer";
import { reduceRun, type RunState } from "@/components/chat/useRunStream";
import type { RunEvent } from "@/lib/hermes";

const fixture = (name: string) => {
  const text = fs.readFileSync(path.join(__dirname, "fixtures/hermes", name), "utf8");
  const p = new SseParser();
  return [...p.push(text), ...p.end()].filter((f) => f.data).map((f) => normalizeRunEvent(runEventSchema.parse(JSON.parse(f.data)) as never));
};

const NOW = 1_793_200_000_000;
function translate(events: RunEvent[], opts: { resumeFromSeq?: number; close?: boolean } = {}) {
  const t = new HermesAguiTranslator({ threadId: "sess_1", hermesRunId: "run_abc", now: () => NOW, resumeFromSeq: opts.resumeFromSeq });
  const out = events.flatMap((e) => t.push(e));
  if (opts.close) out.push(...t.close("upstream closed"));
  return out;
}

/** Split into AG-UI runs (one per RUN_STARTED) and run the protocol verifier on each. */
async function verifyRuns(events: AGUIEvent[]) {
  const runs: AGUIEvent[][] = [];
  for (const e of events) {
    if (e.type === EventType.RUN_STARTED) runs.push([]);
    runs.at(-1)!.push(e);
  }
  for (const r of runs) {
    const ok = await lastValueFrom(from(r as BaseEvent[]).pipe(verifyEvents(false), toArray()));
    expect(ok).toHaveLength(r.length);
  }
  return runs;
}

const initial: RunState = { phase: "running", text: "", reasoning: "", activity: [], steerQueued: 0, attempts: 0, runId: "run_abc" };
const fold = (events: RunEvent[]) => events.reduce((s, event) => reduceRun(s, { type: "event", event }), initial);
const comparable = (s: RunState) => ({
  phase: s.phase,
  text: s.text,
  reasoning: s.reasoning,
  output: s.output,
  error: s.error,
  approval: s.approval,
  activity: s.activity.map((a) =>
    a.kind === "tool" ? { tool: a.tool, preview: a.preview, result: a.result, done: a.done, error: a.error, durationSec: a.durationSec } : a.kind,
  ),
});
const viaAgui = (agui: AGUIEvent[]) => {
  const st = newAguiReadState();
  // Round-trip through JSON like the SSE wire does.
  return agui.flatMap((e) => {
    const wire = JSON.parse(JSON.stringify(e)) as unknown;
    expect(isAguiEvent(wire)).toBe(true);
    return aguiToRunEvents(wire as AGUIEvent, st);
  });
};

describe("Hermes → AG-UI adapter (recorded fixtures)", () => {
  for (const name of ["hermes-run-tool.sse", "hermes-run-approval.sse"]) {
    it(`${name}: every event passes @ag-ui/core schemas and the @ag-ui/client verifier`, async () => {
      const agui = translate(fixture(name));
      for (const e of agui) expect(() => EventSchemas.parse(e)).not.toThrow();
      const runs = await verifyRuns(agui);
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(agui.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "success" } });
    });

    it(`${name}: the browser ends in the same state as with Jarvis events`, () => {
      const jarvis = fixture(name);
      expect(comparable(fold(viaAgui(translate(jarvis))))).toEqual(comparable(fold(jarvis)));
    });
  }

  it("tool calls get synthesised ids, preview args and an ok/duration result", () => {
    const agui = translate(fixture("hermes-run-tool.sse"));
    const start = agui.find((e) => e.type === EventType.TOOL_CALL_START)!;
    expect(start).toMatchObject({ toolCallName: "terminal", toolCallId: "tc_run_abc_0" });
    const args = agui.find((e) => e.type === EventType.TOOL_CALL_ARGS)!;
    expect(JSON.parse((args as { delta: string }).delta)).toEqual({ preview: "echo jarvis-fixture" });
    const res = agui.find((e) => e.type === EventType.TOOL_CALL_RESULT) as { toolCallId: string; content: string };
    expect(res.toolCallId).toBe("tc_run_abc_0");
    expect(JSON.parse(res.content)).toMatchObject({ ok: true });
  });

  it("a blocking approval ends the AG-UI run with an interrupt, and the answer starts the next run", async () => {
    const agui = translate(fixture("hermes-run-approval.sse"));
    const runs = await verifyRuns(agui);
    expect(runs).toHaveLength(2);
    const finished = runs[0]!.at(-1) as Extract<AGUIEvent, { type: EventType.RUN_FINISHED }>;
    expect(finished.outcome?.type).toBe("interrupt");
    const interrupt = finished.outcome?.type === "interrupt" ? finished.outcome.interrupts[0]! : null;
    expect(interrupt).toMatchObject({
      id: "int_b117d6dc7e684ec99017e93c8d794f08",
      reason: "tool_call",
      toolCallId: "tc_appr_b117d6dc7e684ec99017e93c8d794f08",
      message: "delete in root path",
      metadata: { hermes: { requestId: "b117d6dc7e684ec99017e93c8d794f08", choices: ["once", "session", "always", "deny"] } },
    });
    expect(Date.parse(interrupt!.expiresAt!)).toBe(NOW + HERMES_APPROVAL_TIMEOUT_S * 1000);
    expect(runs[0]!.some((e) => e.type === EventType.TOOL_CALL_START && e.toolCallName === APPROVAL_TOOL)).toBe(true);
    // Next run: new id on the same thread, approval tool result, then the rest of the Hermes run.
    expect(runs[1]![0]).toMatchObject({ type: EventType.RUN_STARTED, threadId: "sess_1", parentRunId: "run_abc" });
    expect((runs[1]![0] as { runId: string }).runId).not.toBe("run_abc");
    const result = runs[1]!.find((e) => e.type === EventType.TOOL_CALL_RESULT && e.toolCallId === interrupt!.toolCallId) as { content: string };
    expect(JSON.parse(result.content)).toEqual({ choice: "deny" });
    // The terminal command that was waiting on the approval completes with an error result.
    const term = runs[1]!.find((e) => e.type === EventType.TOOL_CALL_RESULT && e.toolCallId === "tc_run_abc_0") as { content: string };
    expect(JSON.parse(term.content)).toMatchObject({ ok: false });
  });

  it("the interrupt shows the approval card; the approval result clears it", () => {
    const agui = translate(fixture("hermes-run-approval.sse"));
    const cut = agui.findIndex((e) => e.type === EventType.RUN_FINISHED) + 1;
    const mid = fold(viaAgui(agui.slice(0, cut)));
    expect(mid.phase).toBe("waiting_for_approval");
    expect(mid.approval).toMatchObject({ requestId: "b117d6dc7e684ec99017e93c8d794f08", choices: ["once", "session", "always", "deny"] });
    expect(fold(viaAgui(agui)).approval).toBeUndefined();
  });

  it("a reconnect mid-run starts a new run segment; a tool that started earlier only completes", async () => {
    const all = fixture("hermes-run-tool.sse");
    const after = all.filter((e) => "seq" in e && (e.seq ?? -1) > 0);
    const agui = translate(after, { resumeFromSeq: 0 });
    await verifyRuns(agui);
    expect(agui[0]).toMatchObject({ type: EventType.RUN_STARTED, runId: "run_abc~0", parentRunId: "run_abc" });
    const start = agui.find((e) => e.type === EventType.TOOL_CALL_START) as { metadata?: { jarvis?: { resumed?: boolean } } };
    expect(start.metadata?.jarvis?.resumed).toBe(true);
    const events = viaAgui(agui);
    expect(events.filter((e) => e.type === "tool.started")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(1);
  });

  it("a stream that closes early is an error the client reconciles, never a completion", async () => {
    const partial = fixture("hermes-run-tool.sse").slice(0, 4);
    const agui = translate(partial, { close: true });
    await verifyRuns(agui);
    expect(agui.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: STREAM_CLOSED });
    expect(viaAgui(agui).at(-1)).toMatchObject({ type: "stream.closed" });
  });

  it("failed / cancelled Hermes runs become RUN_ERROR with the Hermes status", () => {
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      const agui = translate([
        { type: "text.delta", seq: 1, delta: "Hi" },
        { type: "run.terminal", seq: 2, status, error: "boom", at: "2026-10-28T00:00:00Z" },
      ]);
      for (const e of agui) EventSchemas.parse(e);
      expect(agui.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: `hermes.${status}` });
      expect(viaAgui(agui).at(-1)).toMatchObject({ type: "run.terminal", status });
    }
  });

  it("commentary, steering and subagents map to CUSTOM / SUBAGENT events and back", async () => {
    const at = "2026-10-28T00:00:00Z";
    const src: RunEvent[] = [
      { type: "commentary", seq: 1, text: "Looking" },
      { type: "subagent.started", seq: 2, id: "sa1", goal: "research", at },
      { type: "steer.queued", seq: 3, at },
      { type: "subagent.completed", seq: 4, id: "sa1", goal: "research", summary: "done", status: "completed", at },
      { type: "unknown", seq: 5, event: "something.new" },
      { type: "run.terminal", seq: 6, status: "completed", output: "ok", at },
    ];
    const agui = translate(src);
    for (const e of agui) EventSchemas.parse(e);
    await verifyRuns(agui);
    expect(agui.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.CUSTOM,
      EventType.SUBAGENT_STARTED,
      EventType.CUSTOM,
      EventType.SUBAGENT_FINISHED,
      EventType.RAW,
      EventType.RUN_FINISHED,
    ]);
    expect(comparable(fold(viaAgui(agui)))).toEqual(comparable(fold(src)));
  });

  it("AG-UI resume entries map to Hermes approval choices, failing closed", () => {
    const offered = ["once", "session", "deny"] as const;
    const o = [...offered];
    expect(approvalChoiceFromResume({ interruptId: "i", status: "resolved", payload: { approved: true, scope: "session" } }, o)).toBe("session");
    expect(approvalChoiceFromResume({ interruptId: "i", status: "resolved", payload: { approved: true } }, o)).toBe("once");
    expect(approvalChoiceFromResume({ interruptId: "i", status: "resolved", payload: { approved: true, scope: "always" } }, o)).toBe("once");
    expect(approvalChoiceFromResume({ interruptId: "i", status: "resolved", payload: { approved: false } }, o)).toBe("deny");
    expect(approvalChoiceFromResume({ interruptId: "i", status: "resolved", payload: "yes" }, o)).toBe("deny");
    expect(approvalChoiceFromResume({ interruptId: "i", status: "cancelled", payload: { approved: true } }, o)).toBe("deny");
  });

  it("Jarvis-format events are not mistaken for AG-UI", () => {
    expect(isAguiEvent({ type: "text.delta", delta: "x" })).toBe(false);
    expect(isAguiEvent({ type: "RUN_STARTED", threadId: "t", runId: "r" })).toBe(true);
  });
});
