import { describe, expect, it } from "vitest";
import { executionTitle, presentExecutions } from "./execution-presentation";

const record = (overrides = {}) => ({
  key: "subagent:a",
  id: "sa-a",
  source: "subagent" as const,
  title: "Act as a release specialist. Verify the phone sheet at /home/hermes/.hermes/long-path and report findings.",
  state: "running" as const,
  ...overrides,
});

describe("execution presentation", () => {
  it("uses a bounded stored-goal heading without leaking local paths", () =>
    expect(executionTitle(record())).toBe("Verify the phone sheet at local path and report findings."));
  it("groups only complete delegation identities and retains mixed member states", () => {
    const parent = record({ key: "subagent:one", id: "sa-0", delegationId: "delegate:a", state: "running" as const });
    const failedChild = record({ key: "subagent:two", id: "sa-1", delegationId: "delegate:a", state: "failed" as const, error: "failed" });
    const collidingLocalHandle = record({ key: "subagent:three", id: "sa-0", delegationId: "delegate:b", state: "waiting" as const });
    const sameTitle = record({ key: "subagent:four", id: "sa-2", title: parent.title, state: "completed" as const });
    const groups = presentExecutions([parent, failedChild, collidingLocalHandle, sameTitle]);
    expect(groups.map((group) => group.members.map((member) => member.state))).toEqual([["running", "failed"], ["waiting"], ["completed"]]);
  });
});
