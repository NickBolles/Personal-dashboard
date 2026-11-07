import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setTestDatabase, getDb, getSqlite, schema } from "@/server/db";
import { userById, type CurrentUser } from "@/server/auth";
import { setSetting, updatePreferences } from "@/server/settings";
import { createItem, listItems, placeConversation, undoOp, updateItem } from "@/server/work/store";
import { createJob, jobRow, listSchedules, patchJob, R } from "@/server/agents/schedules";
import { defaultDeps, reconcileScheduledRuns, runSchedulePass, type SchedulerDeps } from "@/server/agents/scheduler";
import { createItemFromFeedback, deleteFeedback, getFeedback, listFeedback, patchFeedback, rateMessage, triageCandidates, F } from "@/server/feedback/store";
import {
  buildTriagePayload,
  canTransition,
  excerptOf,
  fixPrompt,
  messageLink,
  FEEDBACK_TRIAGE_TEMPLATE,
  TRIAGE_MAX_ENTRIES,
  type TriageEntry,
} from "@/lib/feedback";

vi.mock("@/server/assistant", () => ({
  createSession: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  getSessionDetail: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  updateSession: vi.fn(),
  sessionAccess: vi.fn(),
  getSessionSummary: vi.fn(),
  listLocalConversations: vi.fn(),
  visibleSessions: vi.fn(),
  reconcileRun: vi.fn(),
}));

const now = new Date("2026-11-07T14:00:00.000Z"); // 08:00 Chicago, outside quiet hours
let owner: CurrentUser;
let areaId: string;
let deps: SchedulerDeps;
let counter: number;

const rate = (messageId: string, patch: Partial<Parameters<typeof rateMessage>[1]> = {}, sessionId = "s-home") =>
  rateMessage(
    owner,
    { sessionId, messageId, surface: "chat", rating: "down", reasons: ["wrong"], note: "It is Wednesday", text: "Pickup is **Thursday**.", ...patch },
    "test",
    now,
  );

beforeAll(() => {
  __setTestDatabase();
});
afterEach(() => {
  getSqlite().exec("ROLLBACK TO fb_test; RELEASE fb_test");
  vi.unstubAllGlobals();
});
beforeEach(() => {
  getSqlite().exec("SAVEPOINT fb_test");
  getDb().insert(schema.users).values({ id: "owner", name: "Owner", role: "admin" }).run();
  setSetting("owner_user_id", "owner");
  owner = userById("owner")!;
  updatePreferences({ timezone: "America/Chicago" });
  areaId = createItem(owner, { kind: "area", title: "Home" }, "test").id;
  updateItem(owner, areaId, { settings: { agentMode: "chiefofstaff", autonomy: "propose" } }, "test");
  placeConversation(owner, { sessionId: "s-home", parentId: areaId, title: "Garbage day" }, "test");
  counter = 0;
  deps = {
    ...defaultDeps,
    createSession: vi.fn(async (_u, title) => ({ id: `session-${++counter}`, title: title ?? "Schedule", source: "hermes", pinned: false, archived: false })),
    startRun: vi.fn(async (_u, r) => ({ runId: `hermes-${++counter}`, sessionId: r.sessionId, status: "running" as const })),
    getRun: vi.fn(async (_u, runId) => ({ runId, sessionId: "session", status: "running" as const })),
    getSessionDetail: vi.fn(),
    resolveAgentForNode: vi.fn(() => ({ requested: "chiefofstaff", profile: null, routed: false, reason: "routing_off", from: null })),
    sessionProfile: vi.fn(() => null),
    notify: vi.fn(),
  } as SchedulerDeps;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in feedback tests");
    }),
  );
});

describe("feedback storage", () => {
  it("stores a rating with its context and keeps one per message", () => {
    const a = rate("m1", { tools: ["web_search", "web_search", "terminal"], model: "gpt-6.1-sol" });
    expect(a).toMatchObject({
      rating: "down",
      reasons: ["wrong"],
      note: "It is Wednesday",
      excerpt: "Pickup is Thursday.",
      profile: "default",
      areaId,
      areaTitle: "Home",
      model: "gpt-6.1-sol",
      tools: ["web_search", "terminal"],
      status: "new",
    });
    const b = rate("m1", { reasons: ["wrong", "too_long"], note: "", model: undefined });
    expect(b.id).toBe(a.id);
    expect(b.reasons).toEqual(["wrong", "too_long"]);
    expect(b.model).toBe("gpt-6.1-sol");
    expect(getDb().select().from(F).all()).toHaveLength(1);
  });
  it("👍 drops reasons, and changing the verdict makes it new again", () => {
    const a = rate("m2");
    patchFeedback(owner, a.id, { status: "triaged" }, "test", now);
    const up = rate("m2", { rating: "up" });
    expect(up).toMatchObject({ rating: "up", reasons: [], status: "new", triagedAt: null });
  });
  it("status transitions record triage time and can be undone by patching back", () => {
    const a = rate("m3");
    expect(canTransition("new", "new")).toBe(false);
    expect(canTransition("triaged", "new")).toBe(true);
    const t = patchFeedback(owner, a.id, { status: "fixed" }, "test", now);
    expect(t.status).toBe("fixed");
    expect(t.triagedAt).toBe(now.toISOString());
    const back = patchFeedback(owner, a.id, { status: "new" }, "test", now);
    expect(back).toMatchObject({ status: "new", triagedAt: null });
    expect(patchFeedback(owner, a.id, { fixRequested: true }, "test", now).fixRequestedAt).toBe(now.toISOString());
  });
  it("filters the inbox and only shows the rater's own feedback", () => {
    rate("m4");
    rate("m5", { rating: "up" });
    rate("m6", { reasons: ["slow"] }, "s-other");
    getDb().insert(schema.users).values({ id: "kid", name: "Kid", role: "adult" }).run();
    const kid = userById("kid")!;
    expect(listFeedback(kid).entries).toHaveLength(0);
    expect(listFeedback(owner).entries).toHaveLength(3);
    expect(listFeedback(owner, { rating: "down" }).entries).toHaveLength(2);
    expect(listFeedback(owner, { reason: "slow" }).entries.map((e) => e.messageId)).toEqual(["m6"]);
    expect(
      listFeedback(owner, { areaId })
        .entries.map((e) => e.messageId)
        .sort(),
    ).toEqual(["m4", "m5"]);
    expect(listFeedback(owner).counts).toEqual({ total: 3, down: 2, newDown: 2 });
    expect(listFeedback(owner).areas).toEqual([{ id: areaId, title: "Home" }]);
    expect(() => getFeedback(kid, listFeedback(owner).entries[0].id)).toThrow(/isn't here/);
  });
  it("deletes a rating", () => {
    const a = rate("m7");
    deleteFeedback(owner, a.id, "test");
    expect(listFeedback(owner).entries).toHaveLength(0);
  });
  it("creates an item under the area that links back, once, with Undo", () => {
    const a = rate("m8");
    const r = createItemFromFeedback(owner, a.id, "test", now);
    const item = listItems(owner.id).find((i) => i.id === r.itemId)!;
    expect(item).toMatchObject({ parentId: areaId, kind: "thread" });
    expect(item.title).toMatch(/^Feedback: Wrong · Pickup is Thursday/);
    expect(item.summary).toContain("/chat/s-home#msg-m8");
    expect(r.feedback).toMatchObject({ itemId: r.itemId, status: "triaged" });
    expect(r.op?.id).toBeTruthy();
    expect(() => createItemFromFeedback(owner, a.id, "test", now)).toThrow(/already has an item/);
    undoOp(owner, r.op!.id, "test");
    expect(getFeedback(owner, a.id).itemId).toBeNull();
    expect(createItemFromFeedback(owner, a.id, "test", now).itemId).toBeTruthy();
  });
});

describe("pure helpers", () => {
  it("excerpts drop fenced cards and markdown", () => {
    expect(excerptOf("Here **it** is\n```jarvis-ui\n{}\n```\n[link](https://x.y) done")).toBe("Here it is link done");
    expect(excerptOf("x".repeat(700)).length).toBe(600);
  });
  it("builds the fix prompt from reasons and note", () => {
    const p = fixPrompt({ reasons: ["didnt_do_it"], note: "Create the item", excerpt: "I'll look into it" });
    expect(p).toContain("rated bad (Didn't do it)");
    expect(p).toContain("What went wrong: Create the item");
    expect(p).toContain("Do it now");
    expect(p).toContain("Please correct it");
  });
  it("builds the triage payload with links, capped", () => {
    const e = (i: number): TriageEntry => ({
      id: `fb_${i}`,
      createdAt: "2026-11-07T13:00:00.000Z",
      surface: "coordinator",
      profile: "chiefofstaff",
      areaTitle: "Home",
      model: null,
      reasons: ["wrong"],
      note: "multi\nline",
      excerpt: "Pickup is Thursday",
      tools: ["a", "a", "b"],
      link: messageLink("https://j.example/", "s", `m${i}`),
    });
    expect(buildTriagePayload([], null)).toBe("");
    const one = buildTriagePayload([e(1)], "2026-11-06T00:00:00Z");
    expect(one).toContain("New thumbs-down feedback since 2026-11-06 (1):");
    expect(one).toContain("[fb_1] 2026-11-07 13:00 UTC · Coordinator · @chiefofstaff · Home");
    expect(one).toContain("Owner note: multi line");
    expect(one).toContain("Tools used: a, b");
    expect(one).toContain("Message: https://j.example/chat/s#msg-m1");
    const many = buildTriagePayload(
      Array.from({ length: TRIAGE_MAX_ENTRIES + 2 }, (_, i) => e(i)),
      null,
    );
    expect(many).toContain("(2 more wait for the next run.)");
    expect(many).not.toContain(`[fb_${TRIAGE_MAX_ENTRIES}]`);
  });
});

describe("daily feedback triage job", () => {
  function triageJob() {
    const { key: _key, ...t } = FEEDBACK_TRIAGE_TEMPLATE;
    const created = createJob(owner, { ...t, areaId, enabled: false }, "test", now);
    patchJob(owner, created.id, { enabled: true, schedule: { freq: "daily", time: "08:00", days: [] } }, "test", now);
    return jobRow(owner, created.id);
  }
  it("is seeded once, disabled, on installs that already had templates", () => {
    setSetting("global_coordinator_area_id", areaId);
    setSetting("away_templates_seeded:owner", true);
    const a = listSchedules(owner, now);
    const b = listSchedules(owner, now);
    expect(a.jobs.map((j) => j.templateKey)).toEqual(["daily-feedback-triage"]);
    expect(b.jobs).toHaveLength(1);
    expect(a.jobs[0]).toMatchObject({ enabled: false, kind: "feedback", areaId });
  });
  it("leaves out AI-excluded areas and sensitive notes", () => {
    const secret = createItem(owner, { kind: "area", title: "Private" }, "test").id;
    updateItem(owner, secret, { settings: { aiPolicy: "excluded" } }, "test");
    placeConversation(owner, { sessionId: "s-private", parentId: secret, title: "Private chat" }, "test");
    rate("p1", {}, "s-private");
    rate("p2", { note: "my password is hunter2-Very-Secret" });
    rate("p3");
    rate("p4", { rating: "up" });
    expect(triageCandidates(owner).map((e) => e.id)).toEqual([listFeedback(owner).entries.find((e) => e.messageId === "p3")!.id]);
  });
  it("skips the slot when there is nothing new", async () => {
    triageJob();
    await runSchedulePass(now, deps);
    expect(deps.startRun).not.toHaveBeenCalled();
    expect(getDb().select().from(R).all()[0]).toMatchObject({ status: "skipped", error: "skipped_empty" });
  });
  it("sends new 👎 to the coordinator and marks them triaged when the run finishes", async () => {
    triageJob();
    const a = rate("t1");
    await runSchedulePass(now, deps);
    expect(deps.startRun).toHaveBeenCalledTimes(1);
    const input = vi.mocked(deps.startRun).mock.calls[0][1].input;
    expect(input).toContain("Daily feedback triage.");
    expect(input).toContain(`[${a.id}]`);
    expect(input).toContain("Owner note: It is Wednesday");
    // in flight: not offered to a second run
    expect(triageCandidates(owner)).toHaveLength(0);
    vi.mocked(deps.getRun).mockImplementation(async (_u, runId) => ({ runId, sessionId: "session", status: "completed", output: "Clustered 1 entry." }));
    await reconcileScheduledRuns(owner, new Date(now.getTime() + 60_000), deps);
    expect(getFeedback(owner, a.id)).toMatchObject({ status: "triaged" });
    expect(getFeedback(owner, a.id).triagedAt).toBeTruthy();
  });
  it("puts entries back in the queue when the run fails", async () => {
    triageJob();
    const a = rate("t2");
    vi.mocked(deps.startRun).mockRejectedValue(new Error("Synthetic failure"));
    await runSchedulePass(now, deps);
    expect(getFeedback(owner, a.id).status).toBe("new");
    expect(triageCandidates(owner).map((e) => e.id)).toEqual([a.id]);
  });
});
