/** Skylight completed chores: kept by the adapter, first-seen time + open → done history, Activity, Home trend, HA 14-day cutoff. */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, userById } from "@/server/auth";
import { updatePreferences } from "@/server/settings";
import { adapterContext } from "@/server/sources";
import { recordCompletions } from "@/server/skylight-completions";
import { listActivity } from "@/server/work/activity";
import { homePulse } from "@/server/home/pulse";
import { calendarCheckQuery, choreState, keepChore, mapHermesAnswer } from "@/integrations/skylight/adapter";
import { HA_COMPLETED_DAYS, recentHaItem } from "@/integrations/todos/adapter";
import { baseAction } from "@/integrations/actions";
import type { SourceData } from "@/integrations/types";
import type { AdapterContext } from "@/integrations/types";

let userId: string;
beforeAll(() => {
  __setTestDatabase();
  userId = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  updatePreferences({ timezone: "America/Chicago" });
});
beforeEach(() => {
  getDb().delete(schema.sourceCompletions).run();
});

const chore = (id: string, done: boolean, ctx: AdapterContext) =>
  baseAction("skylight", id, ctx, 60_000, {
    title: `Fixture chore ${id}`,
    detail: "Skylight chore",
    sourceLabel: "Skylight · Chores",
    ...choreState(done, undefined, ctx),
  });
const snap = (actions: SourceData["actions"]): SourceData => ({ actions, events: [], extra: {} });

describe("adapter keeps completed chores inside the read window", () => {
  const today = "2026-11-03";
  const w = { from: "2026-10-27", to: "2026-11-10" };
  it("keeps open and in-window completions, drops skipped and out-of-window completions", () => {
    expect(keepChore({ status: "pending" }, w)).toBe(true);
    expect(keepChore({ status: "complete", completed_on: today }, w)).toBe(true);
    expect(keepChore({ status: "complete", start: today }, w)).toBe(true);
    expect(keepChore({ status: "complete", completed_on: "2026-11-02" }, w)).toBe(true);
    expect(keepChore({ status: "complete", completed_on: "2026-10-20" }, w)).toBe(false);
    expect(keepChore({ status: "skipped", start: today }, w)).toBe(false);
  });

  it("maps a completed chore as completed with no primary action; Hermes mode too", () => {
    const ctx = adapterContext(new Date("2026-11-03T18:00:00Z"));
    expect(choreState(true, undefined, ctx)).toMatchObject({ status: "completed", primaryAction: undefined });
    expect(choreState(false, undefined, ctx)).toMatchObject({ status: "open", primaryAction: { kind: "open" } });
    const data = mapHermesAnswer(
      {
        events: [],
        chores: [
          { id: "1", title: "Fixture open", time: null, completed: false },
          { id: "2", title: "Fixture done", time: null, completed: true },
        ],
      },
      ctx,
    );
    expect(data.actions.map((a) => [a.title, a.status])).toEqual([
      ["Fixture open", "open"],
      ["Fixture done", "completed"],
    ]);
    expect(data.extra).toMatchObject({ counts: { open: 1, completedToday: 1 } });
  });

  it("Test connection reads the calendar on the Chicago day, not the UTC date", () => {
    // 22:47 CT on Nov 3 is already Nov 4 in UTC.
    const ctx = adapterContext(new Date("2026-11-04T04:47:00Z"));
    expect(calendarCheckQuery(ctx)).toEqual({ date_min: "2026-11-03", date_max: "2026-11-03", timezone: "America/Chicago" });
  });
});

describe("completion history", () => {
  it("detects open → done between syncs and keeps the first-seen time", () => {
    const t1 = new Date("2026-11-03T15:00:00Z");
    const ctx1 = adapterContext(t1);
    const first = recordCompletions(snap([chore("a", false, ctx1), chore("b", false, ctx1)]), null, ctx1.today, t1);
    expect(first.actions.every((a) => a.status === "open")).toBe(true);
    const t2 = new Date("2026-11-03T15:30:00Z");
    const ctx2 = adapterContext(t2);
    const second = recordCompletions(snap([chore("a", true, ctx2), chore("b", false, ctx2), chore("c", true, ctx2)]), JSON.stringify(first), ctx2.today, t2);
    expect(second.actions.find((a) => a.sourceId === "a")!.updatedAt).toBe(t2.toISOString());
    const rows = getDb().select().from(schema.sourceCompletions).all();
    expect(Object.fromEntries(rows.map((r) => [r.sourceId, r.wasOpen]))).toEqual({ a: true, c: false });
    // A later sync keeps the first-seen time and writes no duplicate.
    const t3 = new Date("2026-11-03T16:00:00Z");
    const third = recordCompletions(snap([chore("a", true, adapterContext(t3))]), JSON.stringify(second), ctx2.today, t3);
    expect(third.actions[0]!.updatedAt).toBe(t2.toISOString());
    expect(getDb().select().from(schema.sourceCompletions).all()).toHaveLength(2);
  });

  it("shows Skylight completions in Activity (unscoped) and the Home 14-day trend", () => {
    const now = new Date();
    const ctx = adapterContext(now);
    recordCompletions(snap([chore("d", true, ctx)]), JSON.stringify(snap([chore("d", false, ctx)])), ctx.today, now);
    const u = userById(userId)!;
    const feed = listActivity(u, {});
    const row = feed.items.find((i) => i.type === "chore")!;
    expect(row).toMatchObject({ actor: { kind: "system", name: "Skylight" }, verb: "chore completed", object: null, detail: "Fixture chore d" });
    expect(listActivity(u, { types: ["edit"] }).items.some((i) => i.type === "chore")).toBe(false);
    const trend = homePulse(u, now).trend!;
    expect(trend.completed[trend.completed.length - 1]).toBeGreaterThanOrEqual(1);
  });
});

describe("Home Assistant Completed recently", () => {
  it(`drops completed items older than ${HA_COMPLETED_DAYS} days`, () => {
    const now = new Date("2026-11-03T18:00:00Z");
    expect(recentHaItem({ status: "needs_action", due: "2025-12-01" }, now)).toBe(true);
    expect(recentHaItem({ status: "completed", completed: "2026-10-25T10:00:00Z" }, now)).toBe(true);
    expect(recentHaItem({ status: "completed", completed: "2026-10-15T10:00:00Z" }, now)).toBe(false);
    expect(recentHaItem({ status: "completed", due: "2025-12-01" }, now)).toBe(true);
    expect(recentHaItem({ status: "completed" }, now)).toBe(true);
  });
});
