import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import { generatePlan, comparableBest, importSchema, sessionSchema } from "@/lib/workouts";
import { listWorkouts, saveWorkout, importWorkouts } from "@/server/workouts";
import * as route from "@/app/api/workouts/route";
import * as importRoute from "@/app/api/workouts/import/route";

const options = { focuses: ["legs"], minutes: 20, equipment: ["machine"], unit: "lb", neckFriendly: true } as const;
const plan = () => generatePlan({ ...options, focuses: [...options.focuses], equipment: [...options.equipment] }, []);
const document = () => ({ date: "2026-01-10", title: "Training", status: "active" as const, notes: "", exercises: plan() });
const artifact = {
  schemaVersion: 1,
  profile: { displayName: "Synthetic", gym: "Test", units: "lb" },
  liftAliases: { "Leg curl": "Seated leg curl" },
  workouts: [
    {
      id: "fixture-1",
      date: "2026-01-09",
      title: "Fixture",
      type: "Lower",
      notes: "Source note",
      exercises: [
        {
          name: "Leg curl",
          sets: [
            { weight: 20, reps: 8 },
            { note: "Mentioned only", side: "left" },
          ],
        },
      ],
    },
  ],
};
let owner: string, other: string, kid: string;
beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Test", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  kid = createPerson({ name: "Child", username: "child", role: "kid", passcode: "synthetic-pass" }, owner).id;
});

describe("honest planning", () => {
  it("uses no-added-load bodyweight rep records without inventing mass or mixing weighted sets", () => {
    const input = { ...options, focuses: ["core" as const], equipment: ["bodyweight" as const] };
    const exercise = generatePlan(input, [])[0];
    const history = {
      ...document(),
      status: "completed" as const,
      exercises: [
        {
          ...exercise,
          sets: [
            { reps: 10, done: true },
            { weight: 20, reps: 14, done: true },
            { reps: 15, done: false },
          ],
        },
      ],
    };
    expect(sessionSchema.safeParse(history).success).toBe(true);
    const next = generatePlan(input, [history])[0];
    expect(next.best?.highest).toMatchObject({ weight: 0, reps: 10 });
    expect(next.target).toEqual({ weight: 0, reps: 11 });
    expect(next.sets[0].weight).toBeUndefined();
    expect(generatePlan(input, [{ ...history, status: "cancelled" }])[0].best).toBeNull();
  });
  it("preserves fractional legacy reps and unknown source fields without creating PRs", () => {
    const data = structuredClone(artifact);
    data.workouts[0].exercises[0].sets[0].reps = 8.5;
    importWorkouts(owner, data);
    expect(listWorkouts(owner)[0].session.exercises[0].sets[0].reps).toBe(8.5);
    expect(
      comparableBest(
        plan()[0],
        listWorkouts(owner).map((r) => r.session),
        20,
      ),
    ).toBeNull();
  });
  it("keeps neck-straining moves out by default and covers every selected focus", () => {
    const p = generatePlan({ ...options, minutes: 50, focuses: ["push"], equipment: ["machine"] }, []);
    expect(p.some((e) => e.name === "Shoulder press")).toBe(false);
    expect(
      generatePlan({ ...options, minutes: 50, focuses: ["push"], equipment: ["machine"], neckFriendly: false }, []).some((e) => e.name === "Shoulder press"),
    ).toBe(true);
    expect(generatePlan({ ...options, focuses: ["legs", "core"], equipment: ["machine"] }, [])).toEqual([]);
  });
  it("is deterministic, respects equipment and starts without invented loads", () => {
    expect(plan()).toEqual(plan());
    expect(plan().length).toBeGreaterThan(0);
    for (const e of plan()) {
      expect(e.equipment).toBe("machine");
      expect(e.sets[0].weight).toBeUndefined();
      expect(e.sets[0].reps).toBe(8);
      expect(e.best).toBeNull();
    }
  });
  it("compares only completed, exact exercise/equipment/unit/side sets", () => {
    const e = plan()[0];
    const previous = {
      ...document(),
      status: "completed" as const,
      exercises: [
        {
          ...e,
          sets: [
            { weight: 30, reps: 10, done: true },
            { weight: 90, reps: 1, done: false },
          ],
        },
      ],
    };
    expect(comparableBest(e, [previous], 30)).toMatchObject({ highest: { weight: 30, reps: 10 }, atLoad: { reps: 10 } });
    for (const patch of [{ unit: "kg" as const }, { equipment: "dumbbell" as const }, { name: "Different" }, { side: "left" }]) {
      expect(comparableBest({ ...e, ...patch }, [previous], 30)).toBeNull();
    }
    expect(comparableBest({ ...e, equipment: "unknown" }, [previous], 30)).toBeNull();
    const generated = generatePlan({ ...options, focuses: [...options.focuses], equipment: [...options.equipment] }, [previous]);
    expect(generated[0].sets[0]).toMatchObject({ weight: 30, reps: 8, done: false });
    expect(generated[0].target).toMatchObject({ weight: 30, reps: 11 });
  });
  it("rejects invalid dates, negative loads and duplicate import identities", () => {
    expect(importSchema.safeParse({ ...artifact, workouts: [artifact.workouts[0], artifact.workouts[0]] }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...document(), date: "2026-02-30" }).success).toBe(false);
    const d = document();
    d.exercises[0].sets[0].weight = -1;
    expect(sessionSchema.safeParse(d).success).toBe(false);
  });
});

describe("real SQLite persistence", () => {
  it("discards an empty active workout idempotently, rejecting stale and cross-person writes", () => {
    const body = { requestId: "start-cancel-test", id: "session-cancel-test", version: 0, session: document() };
    const saved = saveWorkout(owner, body);
    const cancel = { ...body, requestId: "cancel-request", version: saved.version, session: { ...saved.session, status: "cancelled" as const } };
    expect(() => saveWorkout(other, cancel)).toThrow(/not found/i);
    expect(() => saveWorkout(owner, { ...cancel, version: 0 })).toThrow(/changed/i);
    const cancelled = saveWorkout(owner, cancel);
    expect(saveWorkout(owner, cancel)).toEqual(cancelled);
    expect(listWorkouts(owner)[0].session.status).toBe("cancelled");
    expect(saveWorkout(owner, { ...body, id: "replacement-test", requestId: "replacement-request" }).session.status).toBe("active");
  });
  it("resumes privately and replays an identical request exactly once", () => {
    const body = { requestId: "save-first-request", id: "session-test", version: 0, session: document() };
    const saved = saveWorkout(owner, body);
    expect(saved.version).toBe(1);
    expect(saveWorkout(owner, body)).toEqual(saved);
    expect(listWorkouts(owner)).toHaveLength(1);
    expect(listWorkouts(other)).toEqual([]);
    expect(() => saveWorkout(owner, { ...body, session: { ...body.session, title: "Changed" } })).toThrow(/request/i);
    expect(() => saveWorkout(owner, { ...body, requestId: "stale-request" })).toThrow(/changed/i);
    expect(() => saveWorkout(other, { ...body, version: 1 })).toThrow(/not found/i);
    const update = saveWorkout(owner, { ...body, requestId: "second-request", version: 1, session: { ...body.session, notes: "Saved across reload" } });
    expect(update.version).toBe(2);
    expect(listWorkouts(owner)[0].session.notes).toBe("Saved across reload");
  });
  it("imports atomically, preserves original unknowns and never applies aliases", () => {
    expect(importWorkouts(owner, artifact)).toMatchObject({ imported: 1, skipped: 0 });
    expect(importWorkouts(owner, artifact)).toMatchObject({ imported: 0, skipped: 1 });
    const row = listWorkouts(owner)[0];
    expect(row.source?.workout).toEqual(artifact.workouts[0]);
    expect(row.source?.liftAliases).toEqual(artifact.liftAliases);
    expect(row.session.exercises[0]).toMatchObject({ name: "Leg curl", equipment: "unknown" });
    expect(row.session.exercises[0].sets[1]).toMatchObject({ note: "Mentioned only", side: "left" });
    expect(row.session.exercises[0].sets[1].weight).toBeUndefined();
    const changed = structuredClone(artifact);
    changed.workouts[0].title = "Changed source";
    expect(() => importWorkouts(owner, { ...artifact, workouts: [{ ...artifact.workouts[0], id: "new-one" }, ...changed.workouts] })).toThrow(/changed/i);
    expect(listWorkouts(owner)).toHaveLength(1);
    expect(importWorkouts(other, artifact).imported).toBe(1);
  });
});

async function call(handler: typeof route.GET, user: string | null, method = "GET", body?: unknown, csrf = true) {
  return handler(
    new NextRequest("http://jarvis.test/api/workouts", {
      method,
      headers: {
        ...(user ? { cookie: `jarvis_session=${createSession(user).token}` } : {}),
        ...(csrf ? { "x-jarvis-csrf": "1" } : {}),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({}) },
  );
}
it("enforces authentication, capability, CSRF and payload validation at API boundary", async () => {
  expect((await call(route.GET, null)).status).toBe(401);
  expect((await call(route.GET, kid)).status).toBe(403);
  expect((await call(route.GET, other)).status).toBe(200);
  expect((await call(route.POST as typeof route.GET, owner, "POST", {}, false)).status).toBe(403);
  expect((await call(route.POST as typeof route.GET, owner, "POST", { bad: true })).status).toBe(400);
  expect((await call(importRoute.POST as typeof route.GET, kid, "POST", artifact)).status).toBe(403);
  expect((await call(importRoute.POST as typeof route.GET, owner, "POST", { ...artifact, workouts: [] })).status).toBe(400);
});
