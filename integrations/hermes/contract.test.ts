import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SseParser } from "@/lib/sse";
import { capabilitiesSchema, messageListSchema, runEventSchema, runStatusSchema, sessionEnvelopeSchema } from "./types";
import { messagesToTimeline, normalizeApproval, normalizeRunEvent, normalizeSession, scrub } from "./normalize";

const fx = (f: string) => fs.readFileSync(`contracts/fixtures/hermes/${f}`, "utf8");

describe("Hermes contract fixtures (pinned v2026.9.24)", () => {
  it("parses capabilities and exposes required features", () => {
    const caps = capabilitiesSchema.parse(JSON.parse(fx("capabilities.json")));
    for (const f of ["run_submission", "run_events_sse", "run_stop", "session_fork"]) expect(caps.features[f]).toBeTruthy();
  });

  it("parses a session envelope and normalizes it", () => {
    const s = normalizeSession(sessionEnvelopeSchema.parse(JSON.parse(fx("session.json"))).session);
    expect(s).toMatchObject({ id: "api_1759200000_a1b2c3d4", title: "Dashboard chat", pinned: false, archived: false });
    expect(s.lastActiveAt).toBe(new Date(1759200100.5 * 1000).toISOString());
  });

  it("turns the transcript into distinct user/tool/assistant items and hides compaction rows", () => {
    const list = messageListSchema.parse(JSON.parse(fx("session-messages.json")));
    const t = messagesToTimeline(list.data);
    expect(t.map((x) => x.kind)).toEqual(["user", "tool", "assistant"]);
    expect(t[1]).toMatchObject({ kind: "tool", tool: "terminal", summary: "ls" });
  });

  it("parses the run SSE stream (no event: lines) and normalizes every event type", () => {
    const parser = new SseParser();
    const frames = [...parser.push(fx("run-events.sse")), ...parser.end()];
    const events = frames.map((f) => normalizeRunEvent(runEventSchema.parse(JSON.parse(f.data)) as never));
    expect(events.map((e) => e.type)).toEqual([
      "tool.started",
      "tool.completed",
      "text.delta",
      "approval.requested",
      "approval.resolved",
      "subagent.started",
      "subagent.completed",
      "steer.queued",
      "text.delta",
      "run.terminal",
    ]);
    expect(events[3]).toMatchObject({ requestId: "4b7e0c1d2a3f4e5d6c7b8a9f0e1d2c3b", choices: ["once", "session", "always", "deny"] });
    expect(events[9]).toMatchObject({ status: "completed", output: "Two entries." });
    expect(frames.map((f) => f.id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("run status carries the pending approval with restricted choices", () => {
    const s = runStatusSchema.parse(JSON.parse(fx("run-status-waiting.json")));
    expect(normalizeApproval(s.approval ?? undefined)?.choices).toEqual(["once", "deny"]);
  });

  it("maps unknown events without throwing", () => {
    expect(normalizeRunEvent({ event: "future.thing", seq: 3 } as never)).toEqual({ type: "unknown", seq: 3, event: "future.thing" });
  });

  it("scrubs credential-looking text from tool previews", () => {
    expect(scrub("curl -H 'Authorization: Bearer abcdef123456789'")).not.toContain("abcdef123456789");
    expect(scrub("api_key=supersecretvalue")).toBe("api_key=[redacted]");
  });
});
