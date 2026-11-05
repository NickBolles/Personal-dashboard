import { describe, expect, it } from "vitest";
import { isCoordinatorChange, priorityLine, stablePriority, type PriorityInput } from "@/lib/coordinator/things";
import type { ActivityItem } from "@/lib/activity";

const idle: PriorityInput = { failing: 0, needsYou: 0, doneUnseen: 0, running: 0 };
describe("coordinator change attribution", () => {
  const now = Date.parse("2026-11-07T18:00:00Z");
  const at = "2026-11-07T17:00:00Z";
  it.each([
    [{ kind: "agent", name: "chiefofstaff" }, undefined, true],
    [{ kind: "agent", name: "devchief" }, "chiefofstaff", true],
    [{ kind: "you", name: "You" }, "agent:chiefofstaff", true],
    [{ kind: "agent", name: "devchief" }, undefined, false],
    [{ kind: "agent", name: "chiefofstaff-helper" }, undefined, false],
    [{ kind: "you", name: "chiefofstaff" }, undefined, false],
    [{ kind: "system", name: "chiefofstaff" }, undefined, false],
    [{ kind: "agent", name: "Hermes" }, "agent:devchief", false],
    [{ kind: "agent", name: "chiefofstaff" }, "devchief", false],
  ] as const)("accepts exact actor identity or via: %j %s", (actor, via, expected) => {
    expect(isCoordinatorChange({ actor, via, at }, now)).toBe(expected);
  });
  it("keeps the 24-hour window for run and mutation rows, including the boundary", () => {
    const row: Pick<ActivityItem, "actor" | "via" | "at"> = { actor: { kind: "agent", name: "chiefofstaff" }, at: new Date(now - 86_400_000).toISOString() };
    expect(isCoordinatorChange(row, now)).toBe(true);
    expect(isCoordinatorChange({ ...row, at: new Date(now - 86_400_001).toISOString() }, now)).toBe(false);
    expect(isCoordinatorChange({ ...row, at: "invalid" }, now)).toBe(false);
    expect(isCoordinatorChange({ ...row, via: "chiefofstaff", at: new Date(now - 86_400_001).toISOString() }, now)).toBe(false);
  });
});
describe("coordinator priority line", () => {
  it.each([
    [{ failing: 2, needsYou: 3, doneUnseen: 4, running: 5 }, "failing", "bad", "red", 2],
    [{ needsYou: 3, doneUnseen: 4, running: 5 }, "needs", "warn", "yellow", 3],
    [{ doneUnseen: 4, running: 5 }, "done", "ok", "yellow", 4],
    [{ running: 5 }, "running", "ai", null, 5],
    [{}, "idle", "neutral", null, 0],
  ] as const)("applies strict priority for %j", (values, state, tone, dot, count) => {
    const line = priorityLine({ ...idle, ...values });
    expect(line).toMatchObject({ state, tone, dot, count });
    expect(line.text.length).toBeGreaterThan(0);
  });
  it("uses singular labels", () => {
    expect(priorityLine({ ...idle, failing: 1 }).text).toBe("1 run needs attention");
    expect(priorityLine({ ...idle, needsYou: 1 }).text).toBe("1 thing needs you");
    expect(priorityLine({ ...idle, running: 1 }).text).toBe("1 run in progress");
  });
  it("switches up immediately, updates equal states immediately, and delays down at most four seconds", () => {
    const low = priorityLine(idle);
    const high = priorityLine({ ...idle, failing: 1 });
    const equal = priorityLine({ ...idle, failing: 2 });
    expect(stablePriority(low, high, 1000, 1000)).toBe(high);
    expect(stablePriority(high, equal, 1000, 1001)).toBe(equal);
    expect(stablePriority(high, low, 1000, 1000)).toBe(high);
    expect(stablePriority(high, low, 1000, 4999)).toBe(high);
    expect(stablePriority(high, low, 1000, 5000)).toBe(low);
    expect(stablePriority(high, low, 1000, 9000)).toBe(low);
  });
  it("done outranks running even during hysteresis", () => {
    const running = priorityLine({ ...idle, running: 1 });
    const done = priorityLine({ ...idle, doneUnseen: 1 });
    expect(stablePriority(running, done, 0, 0)).toBe(done);
    expect(stablePriority(done, running, 0, 3999)).toBe(done);
  });
});
