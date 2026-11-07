import { expect, it } from "vitest";
import { parseTaskSegment, taskInSegment } from "@/lib/task-segments";
import type { NextAction } from "@/lib/contracts";
const action = (extra: Partial<NextAction> = {}): NextAction => ({
  id: "t",
  source: "todos",
  sourceId: "t",
  title: "Task",
  status: "open",
  priorityReason: "upcoming",
  updatedAt: "",
  fetchedAt: "",
  staleAfter: "",
  href: "/todos",
  ...extra,
});
it("keeps unassigned personal todos and explicitly mine chores in Mine", () => {
  expect(taskInSegment(action(), "mine")).toBe(true);
  expect(taskInSegment(action({ source: "skylight", assignee: { kind: "mine" } }), "mine")).toBe(true);
  for (const kind of ["other", "up_for_grabs"] as const) expect(taskInSegment(action({ assignee: { kind } }), "mine")).toBe(false);
  expect(taskInSegment(action({ source: "skylight" }), "mine")).toBe(false);
});
it("Waiting includes waiting statuses and open tasks for others/unclaimed, not old completions", () => {
  expect(taskInSegment(action({ status: "waiting" }), "waiting")).toBe(true);
  for (const kind of ["other", "up_for_grabs"] as const) {
    expect(taskInSegment(action({ assignee: { kind } }), "waiting")).toBe(true);
    expect(taskInSegment(action({ status: "completed", assignee: { kind } }), "waiting")).toBe(false);
  }
  expect(taskInSegment(action(), "waiting")).toBe(false);
  expect(taskInSegment(action({ status: "completed" }), "all")).toBe(true);
});
it("validates URL segments including AI", () => {
  expect(parseTaskSegment("mine")).toBe("mine");
  expect(parseTaskSegment("waiting")).toBe("waiting");
  expect(parseTaskSegment("ai")).toBe("ai");
  for (const value of [null, "other", "MINE"]) expect(parseTaskSegment(value)).toBe("all");
});

it("AI uses recorded agent creation, not assignment, source, or a guessed profile", () => {
  expect(taskInSegment(action({ provenance: { via: "agent:devchief", agent: "devchief" } }), "ai")).toBe(true);
  expect(taskInSegment(action({ provenance: { via: "agent:homelabchief" }, status: "completed" }), "ai")).toBe(true);
  expect(taskInSegment(action(), "ai")).toBe(false);
  expect(taskInSegment(action({ provenance: { via: "user", agent: "devchief" } }), "ai")).toBe(false);
  expect(taskInSegment(action({ assignee: { kind: "other", name: "devchief" } }), "ai")).toBe(false);
});
