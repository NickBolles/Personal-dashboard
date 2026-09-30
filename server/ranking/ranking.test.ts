import { describe, expect, it } from "vitest";
import type { NextAction, PriorityReason } from "@/lib/contracts";
import { classifyDue, compareActions, dedupeActions, partitionForHome, rankActions } from "./index";

const NOW = new Date("2026-09-30T15:00:00Z");
const EOD = new Date("2026-10-01T05:00:00Z");

function action(p: Partial<NextAction> & { id: string }): NextAction {
  return {
    source: "todos",
    sourceId: p.id,
    title: p.id,
    status: "open",
    priorityReason: "upcoming",
    updatedAt: "2026-09-30T10:00:00Z",
    fetchedAt: NOW.toISOString(),
    staleAfter: "2026-09-30T16:00:00Z",
    href: "/todos",
    ...p,
  };
}

describe("classifyDue", () => {
  it("returns upcoming with no due date", () => {
    expect(classifyDue({ now: NOW, endOfToday: EOD })).toBe("upcoming");
  });
  it("overdue when due in the past", () => {
    expect(classifyDue({ dueAt: "2026-09-30T14:59:00Z", now: NOW, endOfToday: EOD })).toBe("overdue");
  });
  it("due_soon within four hours (inclusive)", () => {
    expect(classifyDue({ dueAt: "2026-09-30T19:00:00Z", now: NOW, endOfToday: EOD })).toBe("due_soon");
    expect(classifyDue({ dueAt: "2026-09-30T15:00:00Z", now: NOW, endOfToday: EOD })).toBe("due_soon");
  });
  it("today when later today but beyond four hours", () => {
    expect(classifyDue({ dueAt: "2026-09-30T19:01:00Z", now: NOW, endOfToday: EOD })).toBe("today");
  });
  it("upcoming when after the end of today", () => {
    expect(classifyDue({ dueAt: "2026-10-01T05:00:00Z", now: NOW, endOfToday: EOD })).toBe("upcoming");
  });
});

describe("rankActions", () => {
  it("orders every priority reason deterministically", () => {
    const reasons: PriorityReason[] = ["upcoming", "today", "checkin_window", "due_soon", "overdue", "awaiting_user", "critical"];
    const ranked = rankActions(reasons.map((r) => action({ id: r, priorityReason: r })));
    expect(ranked.map((a) => a.priorityReason)).toEqual(["critical", "awaiting_user", "overdue", "due_soon", "checkin_window", "today", "upcoming"]);
  });

  it("tie-breaker 1: pinned first", () => {
    const [first] = rankActions([
      action({ id: "a", priorityReason: "today", dueAt: "2026-09-30T20:00:00Z" }),
      action({ id: "b", priorityReason: "today", dueAt: "2026-09-30T23:00:00Z", pinned: true }),
    ]);
    expect(first!.id).toBe("b");
  });

  it("tie-breaker 2: earliest due, undated last", () => {
    const ranked = rankActions([
      action({ id: "undated", priorityReason: "today" }),
      action({ id: "late", priorityReason: "today", dueAt: "2026-09-30T23:00:00Z" }),
      action({ id: "early", priorityReason: "today", dueAt: "2026-09-30T20:00:00Z" }),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(["early", "late", "undated"]);
  });

  it("tie-breaker 3: most recently changed", () => {
    const ranked = rankActions([action({ id: "old", updatedAt: "2026-09-29T00:00:00Z" }), action({ id: "new", updatedAt: "2026-09-30T00:00:00Z" })]);
    expect(ranked.map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("tie-breaker 4: stable id", () => {
    const a = action({ id: "a" });
    const b = action({ id: "b" });
    expect(rankActions([b, a]).map((x) => x.id)).toEqual(["a", "b"]);
    expect(compareActions(a, a)).toBe(0);
  });
});

describe("dedupeActions", () => {
  it("never merges on similar titles", () => {
    const out = dedupeActions([action({ id: "1", title: "Call mom", sourceId: "x" }), action({ id: "2", title: "Call mom", sourceId: "y" })]);
    expect(out).toHaveLength(2);
  });
  it("merges the same source record and keeps the higher priority", () => {
    const out = dedupeActions([action({ id: "1", sourceId: "x", priorityReason: "today" }), action({ id: "2", sourceId: "x", priorityReason: "overdue" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.priorityReason).toBe("overdue");
  });
  it("merges explicit cross-references", () => {
    const out = dedupeActions(
      [action({ id: "hermes:1", source: "hermes", sourceId: "1" }), action({ id: "todos:1", sourceId: "t1" })],
      new Map([
        ["hermes:1", "link:1"],
        ["todos:1", "link:1"],
      ]),
    );
    expect(out).toHaveLength(1);
  });
});

describe("partitionForHome", () => {
  it("caps Now at three and splits Later sections", () => {
    const p = partitionForHome(
      [
        action({ id: "c", priorityReason: "critical" }),
        action({ id: "o", priorityReason: "overdue" }),
        action({ id: "s", priorityReason: "due_soon" }),
        action({ id: "t", priorityReason: "today" }),
        action({ id: "u", priorityReason: "upcoming" }),
        action({ id: "w", status: "waiting", priorityReason: "today" }),
        action({ id: "done", status: "completed" }),
        action({ id: "deferred", availableAt: "2026-10-02T00:00:00Z", priorityReason: "today" }),
      ],
      NOW,
    );
    expect(p.now.map((a) => a.id)).toEqual(["c", "o", "s"]);
    expect(p.laterToday.map((a) => a.id)).toEqual(["t"]);
    expect(p.upcoming.map((a) => a.id)).toEqual(["deferred", "u"]);
    expect(p.waitingOn.map((a) => a.id)).toEqual(["w"]);
    expect(p.recentlyCompleted.map((a) => a.id)).toEqual(["done"]);
  });
});
