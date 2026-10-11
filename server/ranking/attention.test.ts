import { describe, expect, it } from "vitest";
import type { NextAction } from "@/lib/contracts";
import { BUDGET, matchFocus, selectAttention, type AttentionInput } from "./attention";

const TZ = "America/Chicago";
// Saturday 2026-10-10, 12:00 in Chicago (CDT, UTC-5).
const NOON = new Date("2026-10-10T17:00:00Z");

function action(p: Partial<NextAction> & { id: string }): NextAction {
  return {
    source: "todos",
    sourceId: p.id,
    title: p.id,
    status: "open",
    priorityReason: "upcoming",
    updatedAt: "2026-10-10T10:00:00Z",
    fetchedAt: NOON.toISOString(),
    staleAfter: "2026-10-10T18:00:00Z",
    href: "/todos",
    ...p,
  };
}

/** A Google-style date-only todo due on `date` (end of that local day, like classifyDateOnly). */
function dated(id: string, date: string, extra: Partial<NextAction> = {}) {
  // 23:59 local in Chicago during CDT is 04:59Z the next day.
  const [y, m, d] = date.split("-").map(Number);
  const dueAt = new Date(Date.UTC(y!, m! - 1, d! + 1, 4, 59)).toISOString();
  return action({ id, dueAt, dueIsDate: true, priorityReason: "today", secondaryActions: ["snooze"], ...extra });
}

function select(actions: NextAction[], rest: Partial<AttentionInput> = {}) {
  return selectAttention({ actions, now: NOON, timezone: TZ, ...rest });
}

const ids = (list: NextAction[]) => list.map((a) => a.id);

describe("attention budget", () => {
  it("caps Now at 3 and Today at 5, and counts the rest honestly in the backlog", () => {
    const actions = [
      ...Array.from({ length: 10 }, (_, i) => dated(`today-${i}`, "2026-10-10", { updatedAt: `2026-10-10T0${i % 10}:00:00Z` })),
      ...Array.from({ length: 4 }, (_, i) => dated(`yday-${i}`, "2026-10-09")),
    ];
    const s = select(actions);
    expect(s.now).toHaveLength(BUDGET.now);
    expect(s.today).toHaveLength(BUDGET.today);
    expect(s.totals.open).toBe(14);
    expect(s.totals.now + s.totals.today + s.totals.upcoming + s.totals.backlog).toBe(14);
    expect(s.backlog).toHaveLength(6);
    // Recently overdue items rank above today's.
    expect(ids(s.now).every((id) => id.startsWith("yday-"))).toBe(true);
    // Over-budget items say why they're not shown.
    expect(s.backlog[0]!.why!.join(" ")).toMatch(/Today limit/);
  });

  it("does not promote every overdue task: old overdue stays out of Now", () => {
    const stale = Array.from({ length: 8 }, (_, i) => dated(`old-${i}`, `2026-10-0${i + 1}`));
    const s = select([...stale, dated("today", "2026-10-10")]);
    expect(ids(s.now)).toEqual(["today"]);
    expect(s.totals.overdue).toBe(8);
    // At most two old overdue items may fill spare room in Today; the rest are backlog.
    expect(s.today.length).toBeLessThanOrEqual(2);
    expect(s.today.every((a) => a.rank?.tier === "overdue_stale")).toBe(true);
    expect(s.backlog.length + s.today.length).toBe(8);
    // Most recently due first.
    expect(s.today[0]!.id).toBe("old-7");
  });

  it("never budgets away critical safety items, and they can't be snoozed or demoted", () => {
    const crit = Array.from({ length: 5 }, (_, i) => action({ id: `crit-${i}`, source: "home_assistant", priorityReason: "critical" }));
    const s = select([...crit, dated("today", "2026-10-10")], {
      snoozed: new Map([["crit-0", "2026-10-11T00:00:00Z"]]),
      demoted: new Set(["crit-1"]),
      weights: { "source:home_assistant": -2 },
    });
    expect(ids(s.now)).toEqual(["crit-0", "crit-1", "crit-2", "crit-3", "crit-4"]);
    expect(s.overBudget).toBe(2);
    expect(s.totals.snoozed).toBe(0);
  });
});

describe("snoozes", () => {
  it("hides a snoozed action until the snooze expires, and counts it meanwhile", () => {
    const a = dated("a", "2026-10-10");
    const hidden = select([a], { snoozed: new Map([["a", "2026-10-10T18:00:00Z"]]) });
    expect(hidden.totals.open).toBe(0);
    expect(hidden.totals.snoozed).toBe(1);
    const back = select([a], { snoozed: new Map([["a", "2026-10-10T16:59:00Z"]]) });
    expect(ids(back.now)).toEqual(["a"]);
    expect(back.totals.snoozed).toBe(0);
  });
});

describe("timezone boundaries", () => {
  it("a date-only task due yesterday is overdue only after local midnight", () => {
    const task = dated("t", "2026-10-09");
    // 23:30 on Oct 9 in Chicago (04:30Z on Oct 10): still due today.
    const before = selectAttention({ actions: [task], now: new Date("2026-10-10T04:30:00Z"), timezone: TZ });
    expect(before.now[0]!.rank!.tier).toBe("today");
    expect(before.totals.overdue).toBe(0);
    // 00:30 on Oct 10 in Chicago: recently overdue.
    const after = selectAttention({ actions: [task], now: new Date("2026-10-10T05:30:00Z"), timezone: TZ });
    expect(after.now[0]!.rank!.tier).toBe("overdue_recent");
    expect(after.now[0]!.why!.join(" ")).toMatch(/Due yesterday/);
    // Two calendar days late is stale.
    const later = selectAttention({ actions: [task], now: new Date("2026-10-11T05:30:00Z"), timezone: TZ });
    expect(later.today[0]?.rank?.tier ?? later.backlog[0]?.rank?.tier).toBe("overdue_stale");
  });

  it("reclassifies stale cached reasons from the due date instead of trusting them", () => {
    // Cached yesterday as "upcoming", but the due time has passed.
    const cached = action({ id: "c", priorityReason: "upcoming", dueAt: "2026-10-10T15:00:00Z" });
    const s = select([cached]);
    expect(s.now[0]!.rank!.tier).toBe("overdue_recent");
    expect(s.totals.overdue).toBe(1);
    expect(s.now[0]!.priorityReason).toBe("overdue");
    expect(cached.priorityReason).toBe("upcoming"); // do not mutate the source snapshot
  });

  it("upcoming is limited to two weeks; further out and undated go to the backlog", () => {
    const soon = dated("soon", "2026-10-13");
    const far = dated("far", "2026-11-20");
    const undated = action({ id: "undated" });
    const deferred = action({ id: "deferred", availableAt: "2026-10-11T12:00:00Z", priorityReason: "today" });
    const s = select([soon, far, undated, deferred]);
    expect(ids(s.upcoming)).toEqual(["deferred", "soon"]);
    expect(ids(s.backlog).sort()).toEqual(["far", "undated"]);
    expect(s.backlog.find((a) => a.id === "undated")!.why!.join(" ")).toMatch(/No due date/);
  });
});

describe("Daily Compass focus", () => {
  it("matches significant words, not filler", () => {
    expect(matchFocus("Call plumber about water heater", ["call the plumber"])).toBe("call the plumber");
    expect(matchFocus("Call plumber about water heater", ["Plumbing"])).toBeUndefined();
    expect(matchFocus("Do it", ["do it"])).toBeUndefined();
    expect(matchFocus("Taxes", ["Finish taxes"])).toBeUndefined();
  });

  it("lifts a matching undated task into Now with an explanation", () => {
    const plumber = action({ id: "plumber", title: "Call plumber about water heater" });
    const without = select([plumber, dated("t1", "2026-10-10")]);
    expect(ids(without.now)).toEqual(["t1"]);
    const withFocus = select([plumber, dated("t1", "2026-10-10")], { focus: ["Call plumber"] });
    expect(ids(withFocus.now)).toEqual(["plumber", "t1"]);
    expect(withFocus.now[0]!.why!.join(" ")).toMatch(/Daily Compass focus “Call plumber”/);
  });

  it("missing or empty focus changes nothing", () => {
    const list = [dated("a", "2026-10-10"), action({ id: "b" })];
    expect(ids(select(list, { focus: [] }).now)).toEqual(ids(select(list).now));
  });
});

describe("feedback-driven tuning", () => {
  const pair = () => [dated("todo", "2026-10-10", { source: "todos" }), dated("chore", "2026-10-10", { source: "skylight", sourceId: "chore" })];

  it("a lower category weight ranks that source later within its tier", () => {
    expect(ids(select(pair()).now)).toEqual(["chore", "todo"]); // same due → recent/id tie-break
    expect(ids(select(pair(), { weights: { "source:skylight": -1 } }).now)).toEqual(["todo", "chore"]);
    expect(ids(select(pair(), { weights: { "source:todos": 1, "source:skylight": 0 } }).now)).toEqual(["todo", "chore"]);
  });

  it("weight -2 moves non-urgent items of that category to the backlog, saying why", () => {
    const s = select(pair(), { weights: { "source:todos": -2 } });
    expect(ids(s.now)).toEqual(["chore"]);
    expect(s.backlog[0]!.id).toBe("todo");
    expect(s.backlog[0]!.why!.join(" ")).toMatch(/fewer Todos/);
  });

  it("'wrong assumption' keeps an action out of Now but still visible", () => {
    const waiting = action({ id: "w", source: "hermes", priorityReason: "awaiting_user" });
    const s = select([waiting, dated("t", "2026-10-10")], { demoted: new Set(["w"]) });
    expect(ids(s.now)).toEqual(["t"]);
    expect(ids(s.today)).toEqual(["w"]);
  });

  it("pins lift an undated item into Now", () => {
    const s = select([action({ id: "p", pinned: true }), dated("t", "2026-10-11")]);
    expect(ids(s.now)).toEqual(["p"]);
    expect(s.now[0]!.why).toContain("Pinned by you");
  });
});

describe("counting and identity", () => {
  it("dedupes the same source record before counting", () => {
    const a = dated("todos:1", "2026-10-10", { sourceId: "1" });
    const s = select([a, { ...a, id: "todos:1-copy" }]);
    expect(s.totals.open).toBe(1);
  });

  it("is deterministic regardless of input order", () => {
    const list = [
      dated("a", "2026-10-10"),
      dated("b", "2026-10-09"),
      action({ id: "c", priorityReason: "awaiting_user", source: "hermes" }),
      action({ id: "d" }),
      dated("e", "2026-10-12"),
      dated("f", "2026-10-10", { source: "skylight" }),
    ];
    const forward = select(list);
    const reversed = select([...list].reverse());
    for (const k of ["now", "today", "upcoming", "backlog"] as const) expect(ids(reversed[k])).toEqual(ids(forward[k]));
  });

  it("keeps waiting and completed separate from the budget", () => {
    const s = select([action({ id: "w", status: "waiting" }), action({ id: "done", status: "completed" }), dated("t", "2026-10-10")]);
    expect(s.totals.open).toBe(1);
    expect(ids(s.waiting)).toEqual(["w"]);
    expect(ids(s.completed)).toEqual(["done"]);
  });

  it("every placed action carries its rank and a fingerprint for feedback", () => {
    const s = select([dated("t", "2026-10-10")]);
    expect(s.now[0]!.rank).toMatchObject({ tier: "today", bucket: "now", category: "source:todos" });
    expect(s.now[0]!.rank!.fingerprint).toMatch(/\S/);
  });
});
