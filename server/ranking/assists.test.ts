import { describe, expect, it } from "vitest";
import type { CalendarEvent, NextAction } from "@/lib/contracts";
import { ASSIST_LIMIT, buildAssists, nextOccurrence, type AssistInput } from "./assists";

const TZ = "America/Chicago";
const NOW = new Date("2026-10-10T17:00:00Z"); // Sat Oct 10, noon CDT

function overdue(id: string, date: string, extra: Partial<NextAction> = {}): NextAction {
  const [y, m, d] = date.split("-").map(Number);
  return {
    id: `todos:${id}`,
    source: "todos",
    sourceId: id,
    title: `Task ${id}`,
    status: "open",
    priorityReason: "overdue",
    dueAt: new Date(Date.UTC(y!, m! - 1, d! + 1, 4, 59)).toISOString(),
    dueIsDate: true,
    updatedAt: "2026-10-01T00:00:00Z",
    fetchedAt: NOW.toISOString(),
    staleAfter: "2026-10-10T18:00:00Z",
    href: "/todos",
    secondaryActions: ["snooze"],
    ...extra,
  };
}

function input(rest: Partial<AssistInput> = {}): AssistInput {
  return { now: NOW, timezone: TZ, overdue: [], events: [], milestones: [], canChat: true, canReschedule: true, ...rest };
}

describe("overdue triage", () => {
  it("appears from real counts (3+), with only reschedulable todos offered for triage", () => {
    const list = [overdue("1", "2026-10-09"), overdue("2", "2026-10-05"), overdue("3", "2026-09-20"), overdue("4", "2026-09-01", { secondaryActions: [] })];
    const [card] = buildAssists(input({ overdue: list }));
    expect(card!.kind).toBe("overdue_triage");
    expect(card!.body).toMatch(/4 overdue/);
    expect(card!.body).toMatch(/2 of them more than a week late/);
    expect(card!.triage!.actionIds).toEqual(["todos:1", "todos:2", "todos:3"]);
    expect(card!.origin).toBe("data");
  });

  it("is not shown for one or two overdue tasks", () => {
    expect(buildAssists(input({ overdue: [overdue("1", "2026-10-09"), overdue("2", "2026-10-08")] }))).toEqual([]);
  });

  it("offers no reschedule without permission and no chat without chat access", () => {
    const list = ["1", "2", "3"].map((i) => overdue(i, "2026-10-01"));
    const [card] = buildAssists(input({ overdue: list, canReschedule: false, canChat: false }));
    expect(card!.triage).toBeUndefined();
    expect(card!.chat).toBeUndefined();
  });

  it("chat context is bounded, read-only, and never includes finance", () => {
    const list = [
      ...Array.from({ length: 40 }, (_, i) => overdue(`${i}`, "2026-10-01", { title: `A rather long overdue task title number ${i} `.repeat(3) })),
      overdue("fin", "2026-10-01", { source: "finance", id: "finance:x", title: "Pay the card" }),
    ];
    const [card] = buildAssists(input({ overdue: list }));
    expect(card!.chat!.context.length).toBeLessThanOrEqual(1500);
    expect(card!.chat!.context).not.toMatch(/Pay the card/);
    expect(card!.chat!.draft).toMatch(/don’t complete, reschedule or delete anything/);
  });
});

describe("plan ahead", () => {
  it("never invents dates: no milestones and no calendar events means no planning card", () => {
    expect(buildAssists(input()).filter((c) => c.kind === "plan_ahead")).toEqual([]);
  });

  it("uses a saved yearly milestone inside its lead time", () => {
    const m = { id: "m1", title: "Cassidy’s birthday", date: "2020-12-01", yearly: true, leadDays: 60 };
    const [card] = buildAssists(input({ milestones: [m] }));
    expect(card!.kind).toBe("plan_ahead");
    expect(card!.title).toBe("Cassidy’s birthday in 7 weeks");
    expect(card!.body).toMatch(/Tue, Dec 1/);
    expect(card!.origin).toBe("milestone");
    expect(card!.provenance.fingerprint).toBe("m1:2026-12-01");
    expect(card!.chat!.draft).toMatch(/Read-only/);
  });

  it("stays quiet outside the lead time and rolls yearly dates into next year", () => {
    expect(buildAssists(input({ milestones: [{ id: "m", title: "B", date: "2020-12-01", yearly: true, leadDays: 30 }] }))).toEqual([]);
    expect(nextOccurrence({ date: "2019-01-05", yearly: true }, "2026-10-10")).toBe("2027-01-05");
    expect(nextOccurrence({ date: "2020-02-29", yearly: true }, "2026-10-10")).toBe("2027-02-28");
    expect(nextOccurrence({ date: "2026-09-01", yearly: false }, "2026-10-10")).toBeUndefined();
  });

  it("uses birthday or anniversary events already on a calendar this person can see", () => {
    const ev: CalendarEvent = { id: "e1", title: "Cassidy's birthday", startsAt: "2026-10-15", allDay: true, source: "skylight" };
    const other: CalendarEvent = { id: "e2", title: "Soccer", startsAt: "2026-10-12", allDay: true, source: "skylight" };
    const cards = buildAssists(input({ events: [ev, other] }));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.origin).toBe("calendar");
    expect(cards[0]!.basis).toMatch(/Skylight calendar/);
  });
});

describe("seasonal", () => {
  it("suggests Christmas gift planning in season, labelled as a suggestion", () => {
    const [card] = buildAssists(input({ now: new Date("2026-11-15T17:00:00Z") }));
    expect(card!.kind).toBe("seasonal");
    expect(card!.basis).toMatch(/not from your calendar/);
    expect(buildAssists(input()).some((c) => c.kind === "seasonal")).toBe(false);
  });
});

describe("no nagging", () => {
  const list = ["1", "2", "3"].map((i) => overdue(i, "2026-10-01"));
  const id = "assist:overdue_triage";

  it("respects 'not now' until it expires", () => {
    expect(buildAssists(input({ overdue: list, snoozed: new Map([[id, "2026-10-11T05:00:00Z"]]) }))).toEqual([]);
    expect(buildAssists(input({ overdue: list, snoozed: new Map([[id, "2026-10-10T16:00:00Z"]]) }))).toHaveLength(1);
  });

  it("'not helpful' mutes that card for 14 days; 'wrong assumption' until the data changes", () => {
    const fp = buildAssists(input({ overdue: list }))[0]!.provenance.fingerprint;
    const recent = { id, fingerprint: fp, verdict: "not_helpful" as const, createdAt: "2026-10-01T00:00:00Z" };
    expect(buildAssists(input({ overdue: list, muted: [recent] }))).toEqual([]);
    expect(buildAssists(input({ overdue: list, muted: [{ ...recent, createdAt: "2026-09-20T00:00:00Z" }] }))).toHaveLength(1);
    const wrong = { id, fingerprint: fp, verdict: "wrong_assumption" as const, createdAt: "2025-01-01T00:00:00Z" };
    expect(buildAssists(input({ overdue: list, muted: [wrong] }))).toEqual([]);
    // More overdue tasks change the fingerprint, so the card may come back.
    const more = [...list, ...["4", "5", "6"].map((i) => overdue(i, "2026-10-01"))];
    expect(buildAssists(input({ overdue: more, muted: [wrong] }))).toHaveLength(1);
    // A changing count must not break the explicit two-week quiet period.
    expect(buildAssists(input({ overdue: more, muted: [recent] }))).toEqual([]);
  });

  it("a category at -2 stops its cards; at most two cards show", () => {
    expect(buildAssists(input({ overdue: list, weights: { "assist:overdue_triage": -2 } }))).toEqual([]);
    const cards = buildAssists(
      input({
        now: new Date("2026-11-15T17:00:00Z"),
        overdue: list,
        milestones: [{ id: "m1", title: "Anniversary", date: "2020-12-01", yearly: true, leadDays: 60 }],
      }),
    );
    expect(cards).toHaveLength(ASSIST_LIMIT);
    expect(cards.map((c) => c.kind)).toEqual(["overdue_triage", "plan_ahead"]);
  });
});
