import { describe, expect, it } from "vitest";
import { groupSkylightChores, visibleChore } from "@/components/skylight/grouping";
import { choreSections } from "@/components/skylight/SkylightChoreGroups";
import { todaysChores } from "@/components/skylight/TodayChores";
import { applyOverlay, optimisticChecked, settledKeys, UNDO_WINDOW_MS, writeReducer } from "@/components/skylight/writeState";
import { TASK_UX_CLOCKS, skylightTaskUxFixture } from "../e2e/fixtures/skylight-task-ux";
import { inverseOf } from "@/lib/skylight-write";
import { choreWrite } from "@/components/skylight/model";

describe.each(TASK_UX_CLOCKS)("Skylight presentation at DST instant %s", (instant) => {
  it("hides only future DAILY chores, reveals them without modifying source rows", () => {
    const { source, now } = skylightTaskUxFixture(instant);
    const actions = source.data.actions;
    const before = JSON.stringify(actions);
    const opts = { now, timezone: "America/Chicago" };
    const visible = groupSkylightChores(actions, opts).flatMap((g) => g.actions.map((a) => a.title));
    expect(visible).toContain("Daily today visible");
    expect(visible).toContain("Daily overdue visible");
    expect(visible).toContain("Weekly tomorrow visible");
    expect(visible).not.toContain("Daily tomorrow hidden");
    expect(groupSkylightChores(actions, { ...opts, showUpcomingDaily: true }).flatMap((g) => g.actions.map((a) => a.title))).toContain("Daily tomorrow hidden");
    expect(choreSections(actions, opts).flatMap((g) => g.open.map((a) => a.title))).toEqual(visible);
    expect(JSON.stringify(actions)).toBe(before);
    expect(actions.filter((a) => !visibleChore(a, opts))).toHaveLength(1);
  });
  it("Today keeps skipped separate from open/done, never contributes to completed progress", () => {
    const { source, now, day } = skylightTaskUxFixture(instant);
    const today = todaysChores(source.data.actions, day);
    expect(today.find((a) => a.sourceId === "skipped")?.status).toBe("skipped");
    const sections = choreSections(today, { now, timezone: "America/Chicago" });
    expect(sections.flatMap((s) => [...s.open, ...s.done]).some((a) => a.status === "skipped")).toBe(false);
    expect(sections.flatMap((s) => s.skipped).map((a) => a.sourceId)).toEqual(["skipped"]);
    expect(today.some((a) => a.sourceId === "daily-future")).toBe(false);
  });
});

it("reopening a skipped chore can be undone back to skipped, never completed", () => {
  const { source } = skylightTaskUxFixture();
  const skipped = source.data.actions.find((a) => a.status === "skipped")!;
  const reopen = choreWrite(skipped, "chore.reopen")!;
  expect(reopen).toMatchObject({ previousStatus: "skipped" });
  expect(inverseOf(reopen)).toMatchObject({ op: "chore.skip" });
  let state = writeReducer({}, { type: "confirm", key: skipped.id, op: reopen, at: 1 });
  state = writeReducer(state, { type: "success", key: skipped.id, at: 2 });
  state = writeReducer(state, { type: "settle", key: skipped.id, at: 3 });
  state = writeReducer(state, { type: "undo", key: skipped.id, at: 4 });
  state = writeReducer(state, { type: "undone", key: skipped.id, at: 5 });
  expect(applyOverlay([skipped], state, "2026-11-01")[0].status).toBe("skipped");
  expect(optimisticChecked(skipped, state[skipped.id])).toBe(false);
});

it("skip overlay preserves state through readback and Undo restores only its instance unchecked", () => {
  const { source, day } = skylightTaskUxFixture();
  const action = source.data.actions.find((a) => a.sourceId === "daily-today")!;
  const sibling = { ...action, id: "sibling", sourceId: "sibling" };
  let state = writeReducer({}, { type: "confirm", key: action.id, op: { op: "chore.skip", choreId: "series-2026-11-01-0130", title: action.title }, at: 1 });
  state = writeReducer(state, { type: "success", key: action.id, at: 2 });
  state = writeReducer(state, { type: "settle", key: action.id, at: 3 });
  const rows = applyOverlay([action, sibling], state, day);
  expect(rows.map((a) => a.status)).toEqual(["skipped", "open"]);
  expect(settledKeys([{ ...action, status: "completed" }], state, UNDO_WINDOW_MS + 4)).toEqual([]);
  expect(settledKeys(rows, state, UNDO_WINDOW_MS + 4)).toEqual([action.id]);
  state = writeReducer(state, { type: "undo", key: action.id, at: 4 });
  state = writeReducer(state, { type: "undone", key: action.id, at: 5 });
  expect(applyOverlay(rows, state, day).map((a) => a.status)).toEqual(["open", "open"]);
  expect(optimisticChecked(rows[0], state[action.id])).toBe(false);
});
