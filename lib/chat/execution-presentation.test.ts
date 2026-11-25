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
  it("uses a bounded stored-goal heading while retaining the source title", () => {
    const item = record();
    expect(executionTitle(item)).toMatch(/^Verify the phone sheet/);
    expect(item.title).toContain("/home/hermes");
  });
  it("only groups records with an exact durable identifier", () => {
    const related = record({ key: "registered_run:R-7", id: "R-7", source: "registered_run" as const, delegationId: "delegate:sa-a" });
    const child = record({
      key: "subagent:b",
      id: "sa-a-child",
      title: "Unrelated but correlated by exact delegation evidence",
      childSessionId: "chat-a",
      delegationId: "delegate:sa-a",
    });
    const sameTitle = record({ key: "subagent:c", id: "sa-c", title: related.title });
    expect(presentExecutions([related, child, sameTitle]).map((group) => group.members.length)).toEqual([2, 1]);
  });
});
