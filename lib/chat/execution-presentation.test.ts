import { describe, expect, it } from "vitest";
import { executionTitle, presentExecutions } from "./execution-presentation";
import type { ExecutionRecord } from "@/lib/chat-execution";
const record = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  key: "subagent:a",
  id: "sa-a",
  source: "subagent",
  title: "Act as a release specialist. Verify the phone sheet at /home/hermes/.hermes/long-path and report findings.",
  state: "running",
  ...overrides,
});
describe("execution presentation", () => {
  it("uses a stored-goal heading without local paths", () =>
    expect(executionTitle(record())).toBe("Verify the phone sheet at local path and report findings."));
  it("groups only full identities and preserves independent same-title subtasks and mixed states", () => {
    const records = [
      record({ key: "one", delegationId: "deleg_a" }),
      record({ key: "two", id: "sa-1", delegationId: "deleg_a", state: "failed" }),
      record({ key: "three", delegationId: "deleg_b", state: "waiting" }),
      record({ key: "four", id: "other", state: "completed" }),
    ];
    expect(presentExecutions(records).map((g) => g.members.map((r) => r.state))).toEqual([["running", "failed"], ["waiting"], ["completed"]]);
  });
  it("correlates a compound registration and never a reused bare handle", () => {
    const records = [
      record({ key: "registered:r", id: "r", source: "registered_run", delegationId: "deleg_a:sa-0" }),
      record({ key: "sub:child", id: "child", subagentId: "sa-0", delegationId: "deleg_a", state: "failed" }),
      record({ key: "sub:other", id: "other", subagentId: "sa-0", delegationId: "deleg_b" }),
    ];
    const groups = presentExecutions(records);
    expect(groups.map((g) => g.members.length)).toEqual([2, 1]);
    expect(groups[0]?.members[1]?.state).toBe("failed");
  });
  it("deduplicates repeated exact records preserving terminal state", () => {
    const groups = presentExecutions([record(), record({ state: "completed" })]);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.members[0]?.state).toBe("completed");
  });
  it("handles malformed goals and sanitizes before collapsing", () => {
    expect(executionTitle(record({ title: null as unknown as string }))).toBe("Execution details unavailable");
    expect(executionTitle(record({ title: "Verify login\nUse password=secretvalue" }))).toBe("Verify login");
    expect(executionTitle(record({ title: "token=abcdefgh123456" }))).not.toContain("abcdefgh123456");
  });
});
