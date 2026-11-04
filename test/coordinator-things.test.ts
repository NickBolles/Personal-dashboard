import { describe, expect, it } from "vitest";
import { priorityLine, stablePriority, type PriorityInput } from "@/lib/coordinator/things";

const idle: PriorityInput = { failing: 0, needsYou: 0, doneUnseen: 0, running: 0 };
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
