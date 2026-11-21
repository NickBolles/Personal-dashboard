import { describe, expect, it } from "vitest";
import { presentDelegate } from "@/lib/delegate-presentation";

describe("delegate presentation", () => {
  it.each(["spawn", "list", "steer", "stop", "results"])("preserves actual %s outcome", (action) => {
    const d = presentDelegate(
      JSON.stringify({ action, message: "Do the scoped work", subagent_id: "sa-known" }),
      JSON.stringify({ status: "interrupt_requested", note: "Will stop at a boundary" }),
    );
    expect(d.action).toBe(action);
    expect(d.status).toBe("interrupt_requested");
    expect(d.result).toBe("Will stop at a boundary");
    expect(d.requested[0].id).toBe("sa-known");
  });
  it("does not turn no-live steer failure into a finished or stopped agent", () => {
    const d = presentDelegate(
      '{"action":"steer","message":"Use the confirmed variant"}',
      JSON.stringify({ error: "No live subagent 'sa-example' in this conversation's spawn tree. It may have already finished." }),
    );
    expect(d.error).toBe(true);
    expect(d.status).toBeUndefined();
    expect(d.result).toBe("Agent is no longer running; it may have finished.");
  });
  it("keeps multiple requested tasks and returned child outcomes separate", () => {
    const d = presentDelegate(
      JSON.stringify({ tasks: [{ goal: "Research", instructions: "Scope one" }, { goal: "Review" }] }),
      JSON.stringify({
        results: [
          { subagent_id: "a", status: "completed", result: "Found sources", duration_seconds: 12 },
          { subagent_id: "b", status: "failed", error: "Source unavailable" },
        ],
      }),
    );
    expect(d.requested).toHaveLength(2);
    expect(d.returned).toHaveLength(2);
    expect(d.returned[0].result).toBe("Found sources");
    expect(d.returned[0].duration).toBe("12s");
    expect(d.error).toBe(true);
  });
  it("handles dispatch and empty list without inventing completion", () => {
    expect(presentDelegate('{"action":"list"}', '{"count":0,"subagents":[],"note":"No live agents"}').count).toBe(0);
    const d = presentDelegate(undefined, '{"status":"dispatched","count":2,"subagent_ids":["a","b"],"goals":["One","Two"]}');
    expect(d.returned.map((x) => x.status)).toEqual(["dispatched", "dispatched"]);
  });
  it.each(["{broken", "plain output", JSON.stringify(JSON.stringify({ status: "queued", note: "Accepted" }))])("safely handles %s", (output) => {
    expect(() => presentDelegate("[null]", output)).not.toThrow();
  });
  it("redacts fields, preserves long ids, rejects unsafe result links", () => {
    const d = presentDelegate(
      JSON.stringify({ goal: "token=abcdefghijk", subagent_id: "x".repeat(300) }),
      JSON.stringify({ results: [{ url: "javascript:alert(1)", result: "<script>unsafe()</script>" }] }),
    );
    expect(d.requested[0].title).not.toContain("abcdefghijk");
    expect(d.requested[0].id?.length).toBe(300);
    expect(d.returned[0].href).toBeUndefined();
    expect(d.returned[0].result).toBe("<script>unsafe()</script>");
  });
});
