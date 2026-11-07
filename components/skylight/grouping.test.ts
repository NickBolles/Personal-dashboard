import { describe, expect, it } from "vitest";
import type { NextAction } from "@/lib/contracts";
import { choreBucket, dueState, groupSkylightChores } from "./grouping";
import { choreSuggestions } from "./SkylightActionRow";

// 12:00 in America/Chicago (CST) on 2026-11-04; 18:00 UTC.
const now = new Date("2026-11-04T18:00:00Z");
const tz = "America/Chicago";
const opts = { now, timezone: tz };
const at = (day: string, hhmm: string) => {
  // CST = UTC-6 in this window (after the Nov 1 fall-back).
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! + 6, m!)).toISOString();
};

function chore(title: string, day: string, time?: string, overrides: Partial<NextAction> & { recurring?: boolean } = {}): NextAction {
  const { recurring = false, ...rest } = overrides;
  return {
    id: `skylight:${title}`,
    source: "skylight",
    sourceId: title,
    title,
    status: "open",
    priorityReason: "today",
    href: "https://app.ourskylight.com/",
    fetchedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    staleAfter: "2099-01-01T00:00:00Z",
    ...(time ? { dueAt: at(day, time) } : day === "2026-11-04" ? {} : { dueAt: at(day, "23:59"), dueIsDate: true, dueTimezone: tz }),
    skylight: {
      kind: "chore",
      choreId: recurring ? `900-${day}${time ? `-${time.replace(":", "")}` : ""}` : `chore-${title.replace(/\W+/g, "")}`,
      categoryId: "13600771",
      recurring,
      startDate: day,
      ...(time ? { startTime: time } : {}),
      ...(recurring ? { instanceDate: day, ...(time ? { instanceTime: time } : {}) } : {}),
    },
    ...rest,
  };
}
const titles = (a: NextAction[]) => a.map((x) => x.title);

describe("groupSkylightChores", () => {
  it("orders Morning, Afternoon, Evening, Anytime, Next 7 days, then Overdue at the bottom", () => {
    const input = [
      chore("Old", "2026-11-01", "06:00", { priorityReason: "overdue" }),
      chore("Any", "2026-11-04"),
      chore("Eve", "2026-11-04", "20:00"),
      chore("Later", "2026-11-06"),
      chore("Aft", "2026-11-04", "14:00"),
      chore("Morn", "2026-11-04", "06:00", { priorityReason: "overdue" }),
    ];
    const before = JSON.stringify(input);
    const groups = groupSkylightChores(input, opts);
    expect(groups.map((g) => g.label)).toEqual(["Morning", "Afternoon", "Evening", "Anytime", "Next 7 days", "Overdue"]);
    expect(groups.map((g) => titles(g.actions))).toEqual([["Morn"], ["Aft"], ["Eve"], ["Any"], ["Later"], ["Old"]]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("buckets at the noon and 17:00 boundaries by frame-local start time", () => {
    const input = ["00:00", "11:59", "12:00", "16:59", "17:00", "23:59"].map((t) => chore(t, "2026-11-04", t));
    expect(groupSkylightChores(input, opts).map((g) => [g.key, titles(g.actions)])).toEqual([
      ["morning", ["00:00", "11:59"]],
      ["afternoon", ["12:00", "16:59"]],
      ["evening", ["17:00", "23:59"]],
    ]);
  });

  it("buckets recurring BYHOUR 06/14/20 occurrences by their instance time, not the UTC hour", () => {
    const input = ["20:00", "06:00", "14:00"].map((t) => chore(`Occ ${t}`, "2026-11-04", t, { recurring: true }));
    expect(groupSkylightChores(input, opts).map((g) => g.key)).toEqual(["morning", "afternoon", "evening"]);
  });

  it("puts date-only chores in Anytime today, Next 7 days later and Overdue for a past day", () => {
    expect(choreBucket(chore("Today", "2026-11-04"), opts)).toBe("anytime");
    expect(choreBucket(chore("Tomorrow", "2026-11-05"), opts)).toBe("later");
    expect(choreBucket(chore("Yesterday", "2026-11-03"), opts)).toBe("overdue");
    // Without startDate the day comes from the frame-local due day (23:59 CST is already tomorrow in UTC).
    const noStart = chore("No start", "2026-11-04");
    Object.assign(noStart, { dueAt: at("2026-11-04", "23:59"), dueIsDate: true });
    if (noStart.skylight?.kind === "chore") delete noStart.skylight.startDate;
    expect(choreBucket(noStart, opts)).toBe("anytime");
  });

  it("uses the frame day even when the evening chore's instant is tomorrow in UTC", () => {
    const late = chore("Night", "2026-11-04", "23:30");
    expect(late.dueAt!.slice(0, 10)).toBe("2026-11-05");
    expect(choreBucket(late, opts)).toBe("evening");
  });

  it("sorts overdue most recent first and the rest earliest first", () => {
    const input = [
      chore("Week ago", "2026-10-28", "06:00"),
      chore("Yesterday eve", "2026-11-03", "20:00"),
      chore("Yesterday morn", "2026-11-03", "06:00"),
      chore("Two days", "2026-11-02"),
      chore("B 9am", "2026-11-04", "09:00"),
      chore("A 9am", "2026-11-04", "09:00"),
      chore("7am", "2026-11-04", "07:00"),
    ];
    const groups = groupSkylightChores(input, opts);
    expect(titles(groups[0].actions)).toEqual(["7am", "A 9am", "B 9am"]);
    expect(titles(groups.at(-1)!.actions)).toEqual(["Yesterday eve", "Yesterday morn", "Two days", "Week ago"]);
  });

  it("skips done/waiting chores, list items and native todos", () => {
    const list: NextAction = { ...chore("List", "2026-11-04"), skylight: { kind: "list_item", listId: "1", itemId: "2", listLabel: "Groceries" } };
    const todo: NextAction = { ...chore("Todo", "2026-11-04"), source: "todos", skylight: undefined };
    expect(
      groupSkylightChores(
        [chore("Done", "2026-11-04", undefined, { status: "completed" }), chore("Wait", "2026-11-04", undefined, { status: "waiting" }), list, todo],
        opts,
      ),
    ).toEqual([]);
  });

  it("keeps Hermes-mode chores (no Skylight ref) in their time-of-day bucket", () => {
    const hermes: NextAction = { ...chore("Hermes 7am", "2026-11-04", "07:00"), skylight: undefined };
    const groups = groupSkylightChores([hermes], opts);
    expect(groups.map((g) => g.key)).toEqual(["morning"]);
    expect(titles(groups[0].actions)).toEqual(["Hermes 7am"]);
    expect(choreSuggestions(hermes, { now: now.getTime(), timezone: tz })).toEqual([]);
  });
});

describe("dueState", () => {
  it("is overdue (red) for a past day and late (amber) for today past its time", () => {
    expect(dueState(chore("Old", "2026-11-01"), opts)).toBe("overdue");
    expect(dueState(chore("Morn", "2026-11-04", "06:00", { priorityReason: "overdue" }), opts)).toBe("late");
    expect(dueState(chore("Noon", "2026-11-04", "12:00"), opts)).toBeUndefined();
    expect(dueState(chore("Aft", "2026-11-04", "14:00"), opts)).toBeUndefined();
  });
  it("never colours Anytime, later or done chores", () => {
    expect(dueState(chore("Any", "2026-11-04"), opts)).toBeUndefined();
    expect(dueState(chore("Later", "2026-11-06", "06:00"), opts)).toBeUndefined();
    expect(dueState(chore("Done", "2026-11-01", undefined, { status: "completed" }), opts)).toBeUndefined();
  });
});

describe("choreSuggestions", () => {
  const o = { now: now.getTime(), timezone: tz };
  it("overdue one-off: Do now (primary), Skip, Move to today", () => {
    const s = choreSuggestions(chore("Old", "2026-11-01"), o);
    expect(s.map((x) => x.key)).toEqual(["complete", "skip", "reschedule"]);
    expect(s[2].op).toMatchObject({ op: "chore.reschedule", start: "2026-11-04", previousStart: "2026-11-01" });
  });
  it("overdue recurring: no reschedule; occurrence date/time carried", () => {
    const s = choreSuggestions(chore("Occ", "2026-11-03", "06:00", { recurring: true }), o);
    expect(s.map((x) => x.key)).toEqual(["complete", "skip"]);
    expect(s[0].op).toMatchObject({ op: "chore.complete", instanceDate: "2026-11-03", instanceTime: "06:00" });
  });
  it("up for grabs: Claim; done: Reopen; today's chore: nothing", () => {
    expect(choreSuggestions(chore("Grab", "2026-11-04", undefined, { assignee: { kind: "up_for_grabs" } }), o).map((x) => x.key)).toEqual(["claim"]);
    expect(choreSuggestions(chore("Done", "2026-11-04", undefined, { status: "completed" }), o).map((x) => x.key)).toEqual(["reopen"]);
    expect(choreSuggestions(chore("Morn", "2026-11-04", "06:00"), o)).toEqual([]);
  });
});
