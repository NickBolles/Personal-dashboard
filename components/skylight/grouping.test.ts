import { describe, expect, it } from "vitest";
import type { NextAction } from "@/lib/contracts";
import { dueTone, groupSkylightChores } from "./grouping";

const now = new Date("2026-11-04T18:00:00Z"); // Midday in America/Chicago (CST).
const opts = { now, timezone: "America/Chicago" };
const chore = (title: string, startTime?: string, overrides: Partial<NextAction> = {}): NextAction => ({
  id: title,
  source: "skylight",
  sourceId: title,
  title,
  status: "open",
  priorityReason: "today",
  href: "/skylight",
  fetchedAt: now.toISOString(),
  updatedAt: now.toISOString(),
  staleAfter: "2099-01-01T00:00:00Z",
  skylight: { kind: "chore", choreId: title, categoryId: null, startDate: "2026-11-04", startTime },
  ...overrides,
});

const titles = (actions: NextAction[]) => actions.map((a) => a.title);

describe("groupSkylightChores", () => {
  it("orders the day's buckets before overdue, regardless of input or UTC hour", () => {
    const actions = [
      chore("Late", "06:00", { priorityReason: "overdue", dueAt: "2026-11-03T12:00:00Z" }),
      chore("Any time"),
      chore("Evening", "20:00", { dueAt: "2026-11-05T02:00:00Z" }),
      chore("Afternoon", "14:00", { dueAt: "2026-11-04T20:00:00Z" }),
      chore("Morning", "06:00", { dueAt: "2026-11-04T12:00:00Z" }),
    ];
    const before = [...actions];
    const groups = groupSkylightChores(actions, opts);
    expect(groups.map(({ key, label }) => [key, label])).toEqual([
      ["morning", "Morning"],
      ["afternoon", "Afternoon"],
      ["evening", "Evening"],
      ["anytime", "Anytime"],
      ["overdue", "Overdue"],
    ]);
    expect(groups.map((group) => titles(group.actions))).toEqual([["Morning"], ["Afternoon"], ["Evening"], ["Any time"], ["Late"]]);
    expect(actions).toEqual(before);
  });

  it("buckets recurring BYHOUR 06:00 / 14:00 / 20:00 occurrences by frame-local startTime", () => {
    const recurring = ["20:00", "06:00", "14:00"].map((time) => {
      const action = chore(`Occurrence ${time}`, time);
      if (action.skylight?.kind === "chore") Object.assign(action.skylight, { recurring: true, instanceDate: "2026-11-04", instanceTime: time });
      return action;
    });
    expect(groupSkylightChores(recurring, opts).map((group) => [group.key, group.actions[0].skylight])).toEqual([
      ["morning", expect.objectContaining({ recurring: true, startTime: "06:00" })],
      ["afternoon", expect.objectContaining({ recurring: true, startTime: "14:00" })],
      ["evening", expect.objectContaining({ recurring: true, startTime: "20:00" })],
    ]);
  });

  it("respects the noon and 17:00 boundaries", () => {
    const actions = ["23:59", "17:00", "16:59", "12:00", "11:59", "00:00"].map((time) => chore(time, time));
    expect(groupSkylightChores(actions, opts).map((group) => titles(group.actions))).toEqual([
      ["00:00", "11:59"],
      ["12:00", "16:59"],
      ["17:00", "23:59"],
    ]);
  });

  it("sorts by startTime, then due instant, then title", () => {
    const actions = [
      chore("Zulu", "09:00", { dueAt: "2026-11-04T15:00:00Z" }),
      chore("Tomorrow", "09:00", { dueAt: "2026-11-05T15:00:00Z" }),
      chore("Alpha", "09:00", { dueAt: "2026-11-04T09:00:00-06:00" }),
      chore("Earlier time", "06:00", { dueAt: "2026-11-05T12:00:00Z" }),
    ];
    expect(titles(groupSkylightChores(actions, opts)[0].actions)).toEqual(["Earlier time", "Alpha", "Zulu", "Tomorrow"]);
  });

  it("keeps no-time chores in Anytime even with a due instant, sorting dueAt then title and undated last", () => {
    const actions = [
      chore("Undated"),
      chore("Zulu", undefined, { dueAt: "2026-11-04T12:00:00Z" }),
      chore("Tomorrow", undefined, { dueAt: "2026-11-05T00:00:00Z" }),
      chore("Alpha", undefined, { dueAt: "2026-11-04T12:00:00Z" }),
    ];
    const groups = groupSkylightChores(actions, opts);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("anytime");
    expect(titles(groups[0].actions)).toEqual(["Alpha", "Zulu", "Tomorrow", "Undated"]);
  });

  it("puts most recently due overdue chores first and doesn't re-derive overdue from dates", () => {
    const actions = [
      chore("Old", "20:00", { priorityReason: "overdue", dueAt: "2026-10-01T01:00:00Z" }),
      chore("Unclassified past", "06:00", { priorityReason: "upcoming", dueAt: "2026-10-01T01:00:00Z" }),
      chore("Unknown", undefined, { priorityReason: "overdue" }),
      chore("Recent", "06:00", { priorityReason: "overdue", dueAt: "2026-11-03T20:00:00-06:00" }),
      chore("Same day earlier", "20:00", { priorityReason: "overdue", dueAt: "2026-11-03T20:00:00Z" }),
    ];
    const groups = groupSkylightChores(actions, opts);
    expect(titles(groups[0].actions)).toEqual(["Unclassified past"]);
    expect(groups[1].key).toBe("overdue");
    expect(titles(groups[1].actions)).toEqual(["Recent", "Same day earlier", "Old", "Unknown"]);
  });

  it("omits empty buckets, completed/waiting chores, list items and native todos", () => {
    const actions = [
      chore("Done", "06:00", { status: "completed" }),
      chore("Waiting", "14:00", { status: "waiting" }),
      chore("List item", undefined, { skylight: { kind: "list_item", listId: "list", itemId: "item", listLabel: "Groceries" } }),
      chore("Todo", undefined, { source: "todos", skylight: undefined }),
    ];
    expect(groupSkylightChores(actions, opts)).toEqual([]);
    expect(groupSkylightChores([], opts)).toEqual([]);
  });
});

describe("dueTone", () => {
  it("uses the server's overdue day classification for danger, not elapsed time alone", () => {
    expect(dueTone(chore("Overdue", undefined, { priorityReason: "overdue" }), now)).toBe("danger");
    expect(dueTone(chore("Past but not overdue", "06:00", { priorityReason: "upcoming", dueAt: "2026-11-03T12:00:00Z" }), now)).toBeUndefined();
  });

  it("warns only after today's timed due instant has passed", () => {
    expect(dueTone(chore("Morning", "06:00", { dueAt: "2026-11-04T12:00:00Z" }), now)).toBe("warn");
    expect(dueTone(chore("Now", "12:00", { dueAt: now.toISOString() }), now)).toBeUndefined();
    expect(dueTone(chore("Afternoon", "14:00", { dueAt: "2026-11-04T20:00:00Z" }), now)).toBeUndefined();
    expect(dueTone(chore("Evening", "20:00", { dueAt: "2026-11-05T02:00:00Z" }), now)).toBeUndefined();
  });

  it("doesn't warn on date-only, undated or invalid due values", () => {
    expect(dueTone(chore("Anytime", undefined, { dueAt: "2026-11-04T00:00:00Z", dueIsDate: true }), now)).toBeUndefined();
    expect(dueTone(chore("Date", undefined, { dueAt: "2026-11-04" }), now)).toBeUndefined();
    expect(dueTone(chore("Undated"), now)).toBeUndefined();
    expect(dueTone(chore("Invalid", "06:00", { dueAt: "invalid" }), now)).toBeUndefined();
  });

  it("doesn't colour completed chores with an old urgency reason", () => {
    expect(dueTone(chore("Done", undefined, { status: "completed", priorityReason: "overdue" }), now)).toBeUndefined();
    expect(dueTone(chore("Done today", "06:00", { status: "completed", dueAt: "2026-11-04T12:00:00Z" }), now)).toBeUndefined();
  });
});
