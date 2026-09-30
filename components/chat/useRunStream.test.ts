import { describe, expect, it } from "vitest";
import { reduceRun, type RunState } from "./useRunStream";

const base: RunState = { runId: "r1", phase: "running", text: "", reasoning: "", activity: [], steerQueued: 0, attempts: 0 };
const at = "2026-09-30T00:00:00Z";

describe("run state reducer", () => {
  it("accumulates deltas and pairs tool start/complete", () => {
    let s = reduceRun(base, { type: "event", event: { type: "tool.started", tool: "terminal", preview: "ls", at }, seq: 0 });
    s = reduceRun(s, { type: "event", event: { type: "text.delta", delta: "Hi " }, seq: 1 });
    s = reduceRun(s, { type: "event", event: { type: "tool.completed", tool: "terminal", preview: "ok", at }, seq: 2 });
    s = reduceRun(s, { type: "event", event: { type: "text.delta", delta: "there" }, seq: 3 });
    expect(s.text).toBe("Hi there");
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]).toMatchObject({ kind: "tool", done: true, result: "ok" });
    expect(s.lastSeq).toBe(3);
  });

  it("a disconnect never becomes completion", () => {
    const s = reduceRun(base, { type: "phase", phase: "reconnecting" });
    expect(s.phase).toBe("reconnecting");
    const r = reduceRun(s, { type: "reconciled", view: { runId: "r1", sessionId: "s", status: "running" } });
    expect(r.phase).toBe("running");
  });

  it("stopping is sticky until Hermes reports a terminal state", () => {
    let s = reduceRun(base, { type: "phase", phase: "stopping" });
    s = reduceRun(s, { type: "reconciled", view: { runId: "r1", sessionId: "s", status: "running" } });
    expect(s.phase).toBe("stopping");
    s = reduceRun(s, { type: "phase", phase: "reconnecting" });
    expect(s.phase).toBe("stopping");
    s = reduceRun(s, { type: "event", event: { type: "run.terminal", status: "cancelled", at } });
    expect(s.phase).toBe("cancelled");
  });

  it("terminal states are final", () => {
    let s = reduceRun(base, { type: "event", event: { type: "run.terminal", status: "failed", error: "boom", at } });
    s = reduceRun(s, { type: "phase", phase: "reconnecting" });
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("boom");
  });

  it("approvals set and clear the waiting state", () => {
    let s = reduceRun(base, { type: "event", event: { type: "approval.requested", choices: ["once", "deny"], requestId: "q", at } });
    expect(s.phase).toBe("waiting_for_approval");
    expect(s.approval?.requestId).toBe("q");
    s = reduceRun(s, { type: "event", event: { type: "approval.resolved", choice: "once", at } });
    expect(s.phase).toBe("running");
    expect(s.approval).toBeUndefined();
  });

  it("tracks queued steering and unconsumed steer on terminal", () => {
    let s = reduceRun(base, { type: "event", event: { type: "steer.queued", at } });
    expect(s.steerQueued).toBe(1);
    s = reduceRun(s, { type: "event", event: { type: "run.terminal", status: "completed", pendingSteer: "focus", at } });
    expect(s.pendingSteer).toBe("focus");
  });
});
