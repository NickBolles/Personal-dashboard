import { expect, it } from "vitest";
import { deriveCoordinators, type CoordinatorUsageRow } from "@/lib/coordinator-settings";
import { DEFAULT_AREA_SETTINGS, type WorkItem } from "@/lib/work";

const boundaries = { today: "2026-10-29T05:00:00.000Z", week: "2026-10-23T05:00:00.000Z", now: "2026-10-29T18:00:00.000Z" };
const area = (id: string, profile: string, extra = {}): Pick<WorkItem, "id" | "title" | "kind" | "parentId" | "archived" | "settings"> => ({
  id,
  title: id,
  kind: "area",
  parentId: null,
  archived: false,
  settings: { ...DEFAULT_AREA_SETTINGS, agentMode: profile },
  ...extra,
});
const job = (extra = {}): CoordinatorUsageRow => ({
  hermesProfile: "devchief",
  state: "succeeded",
  finishedAt: boundaries.today,
  costUsd: 0.25,
  estimateUsd: 0.5,
  ...extra,
});

it("derives routed coverage and only active, explicitly granted scopes", () => {
  const [c] = deriveCoordinators(
    [{ profile: "devchief" }],
    [
      area("one", "devchief"),
      area("two", "devchief"),
      area("old", "devchief", { archived: true }),
      area("other", "homelabchief"),
      area("project", "devchief", { kind: "project", parentId: "one" }),
    ],
    [
      { profile: "devchief", scopes: ["work.read"], revokedAt: null },
      { profile: "devchief", scopes: ["work.read", "runs.write"], revokedAt: null },
      { profile: "devchief", scopes: ["work.write"], revokedAt: "2026-10-28" },
      { profile: "homelabchief", scopes: ["decisions.write"], revokedAt: null },
    ],
    [],
    boundaries,
  );
  expect(c.areas.map((a) => a.id)).toEqual(["one", "two"]);
  expect(c.scopes).toEqual(["work.read", "runs.write"]);
});

it("uses profile attribution, terminal jobs and local-day boundaries; preserves zero actual cost", () => {
  const [c] = deriveCoordinators(
    [{ profile: "devchief" }],
    [],
    [],
    [
      job(),
      job({ finishedAt: boundaries.week, state: "failed", costUsd: null }),
      job({ costUsd: 0 }),
      job({ hermesProfile: null }),
      job({ hermesProfile: "other" }),
      job({ state: "running" }),
      job({ finishedAt: null }),
      job({ finishedAt: "2026-10-22T23:00:00.000Z" }),
      job({ finishedAt: "2026-10-30T00:00:00.000Z" }),
    ],
    boundaries,
  );
  expect(c.spend).toEqual({ todayUsd: 0.25, sevenDayUsd: 0.75, estimatedJobs: 1, jobs: 3 });
});

it("does not invent routes or scope defaults", () => {
  expect(deriveCoordinators([], [], [], [], boundaries)).toEqual([]);
  const [c] = deriveCoordinators([{ profile: "new" }], [], [], [], boundaries);
  expect(c.scopes).toEqual([]);
  expect(c.spend.jobs).toBe(0);
});
