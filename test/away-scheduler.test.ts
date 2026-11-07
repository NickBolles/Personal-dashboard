import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, getSqlite, schema } from "@/server/db";
import { userById, type CurrentUser } from "@/server/auth";
import { setSetting, updatePreferences } from "@/server/settings";
import { createItem, listItems, updateItem, undoOp } from "@/server/work/store";
import { listActivity } from "@/server/work/activity";
import { agentRuns } from "@/server/work/agent-runs";
import { createJob, patchJob, listSchedules, jobRow, deleteJob, runCaps, R } from "@/server/agents/schedules";
import { listDecisions } from "@/server/work/decisions";
import { defaultDeps, claimJobSlot, runSchedulePass, runJobNow, reconcileScheduledRuns, tickSchedules, type SchedulerDeps } from "@/server/agents/scheduler";
import { awayDigest, dismissAway } from "@/server/agents/away";
import { applyProposals } from "@/server/agents/proposals";
import { PROPOSAL_INTENTS, LOW_RISK_INTENTS, NEVER_INTENTS, RUN_TIMEOUT_MS, type Proposal, type JobInput } from "@/lib/away";
import { mintAgentToken } from "@/server/agent-access/tokens";
import { NextRequest } from "next/server";
import { POST as mcp } from "@/app/api/mcp/route";

// Do not load provider SDKs in this dependency-injected scheduler suite.
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

const now = new Date("2026-11-07T11:30:00.000Z"); // 05:30 Chicago, quiet hours
let owner: CurrentUser;
let areaId: string;
let deps: SchedulerDeps;
let counter: number;
function job(patch: Partial<JobInput> = {}) {
  const created = createJob(
    owner,
    {
      title: "Check in",
      areaId,
      kind: "brief",
      prompt: "Read changes",
      schedule: { freq: "daily", time: "05:30", days: [] },
      overnight: true,
      enabled: false,
      ...patch,
    },
    "test",
    now,
  );
  patchJob(owner, created.id, { enabled: true }, "test", now);
  return jobRow(owner, created.id);
}
function rows() {
  return getDb().select().from(R).all();
}
function complete(output: string) {
  vi.mocked(deps.getRun).mockImplementation(async (_u, runId) => ({ runId, sessionId: "session", status: "completed", output }));
}
function proposals(p: Proposal[]) {
  return `A short report.\n\n\`\`\`jarvis-proposals\n${JSON.stringify(p)}\n\`\`\``;
}
beforeAll(() => {
  __setTestDatabase();
});
afterEach(() => {
  getSqlite().exec("ROLLBACK TO away_test; RELEASE away_test");
  vi.unstubAllGlobals();
});
beforeEach(() => {
  getSqlite().exec("SAVEPOINT away_test");
  getDb().insert(schema.users).values({ id: "owner", name: "Owner", role: "admin" }).run();
  setSetting("owner_user_id", "owner");
  owner = userById("owner")!;
  updatePreferences({ timezone: "America/Chicago", hermes: { defaultModel: "household-model", defaultProvider: "subscription" } });
  areaId = createItem(owner, { kind: "area", title: "Workshop" }, "test").id;
  updateItem(owner, areaId, { settings: { agentMode: "devchief", autonomy: "low_risk" } }, "test");
  counter = 0;
  deps = {
    ...defaultDeps,
    createSession: vi.fn(async (_u, title) => ({ id: `session-${++counter}`, title: title ?? "Schedule", source: "hermes", pinned: false, archived: false })),
    startRun: vi.fn(async (_u, r) => ({ runId: `hermes-${++counter}`, sessionId: r.sessionId, status: "running" as const })),
    getRun: vi.fn(async (_u, runId) => ({ runId, sessionId: "session", status: "running" as const })),
    getSessionDetail: vi.fn(),
    resolveAgentForNode: vi.fn(() => ({ requested: "devchief", profile: null, routed: false, reason: "routing_off", from: null })),
    sessionProfile: vi.fn(() => null),
    notify: vi.fn(),
  } as SchedulerDeps;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in scheduled tests");
    }),
  );
});

describe("schedule store and claims", () => {
  it("seeds templates once and disabled, using the global coordinator area", () => {
    setSetting("global_coordinator_area_id", areaId);
    const a = listSchedules(owner, now);
    const b = listSchedules(owner, now);
    expect(a.jobs).toHaveLength(2);
    expect(b.jobs).toHaveLength(2);
    expect(a.jobs.every((j) => !j.enabled && j.areaId === areaId && j.nextRunAt === null)).toBe(true);
  });
  it("claims a slot once, including concurrent callers", async () => {
    const j = job();
    const claimed = await Promise.all([1, 2].map(() => Promise.resolve().then(() => claimJobSlot(owner, j, "slot", now))));
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });
  it("two ticks in the same slot start one run and file its own conversation", async () => {
    const j = job();
    await runSchedulePass(now, deps);
    await runSchedulePass(now, deps);
    expect(deps.startRun).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(jobRow(owner, j.id).sessionId).toBeTruthy();
    expect(listItems(owner.id).find((i) => i.sessionId === rows()[0].sessionId)?.parentId).toBe(areaId);
    expect(agentRuns(owner).active.some((r) => r.itemId === areaId)).toBe(true);
  });
  it("missed windows and disabled jobs never run", async () => {
    const j = job();
    await runSchedulePass(new Date("2026-11-07T12:01:00Z"), deps);
    patchJob(owner, j.id, { enabled: false }, "test");
    await runSchedulePass(now, deps);
    expect(rows()).toHaveLength(0);
    expect(deps.startRun).not.toHaveBeenCalled();
  });
  it("skips quiet hours unless overnight, while run-now ignores them", async () => {
    const j = job({ overnight: false });
    await runSchedulePass(now, deps);
    expect(rows()[0]).toMatchObject({ status: "skipped", error: "skipped_quiet" });
    await runJobNow(owner, j.id, now, deps);
    expect(deps.startRun).toHaveBeenCalledTimes(1);
  });
  it("records cap skips, and manual runs respect cap", async () => {
    setSetting("away_max_runs_per_day", 1);
    const a = job();
    const b = job({ title: "Second" });
    await runSchedulePass(now, deps);
    expect(
      rows()
        .map((r) => r.status)
        .sort(),
    ).toEqual(["running", "skipped"]);
    expect(jobRow(owner, b.id).lastStatus).toBe("skipped_cap");
    await expect(runJobNow(owner, b.id, now, deps)).rejects.toMatchObject({ code: "daily_cap" });
    await expect(runJobNow(owner, a.id, now, deps)).rejects.toMatchObject({ code: "already_running" });
  });
  it("starts at most two jobs per tick", async () => {
    job();
    job({ title: "2" });
    job({ title: "3" });
    await runSchedulePass(now, deps);
    expect(deps.startRun).toHaveBeenCalledTimes(2);
  });
  it("routes the job to its resolved profile and sends household model defaults", async () => {
    vi.mocked(deps.resolveAgentForNode).mockReturnValue({ requested: "devchief", profile: "devchief", routed: true, reason: "routed", from: null });
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    expect(deps.createSession).toHaveBeenCalledWith(owner, "Scheduled · Check in", "hermes", "devchief");
    expect(vi.mocked(deps.startRun).mock.calls[0][1]).toMatchObject({ model: "household-model", provider: "subscription" });
    expect(rows()[0].profile).toBe("devchief");
    expect(() => patchJob(owner, j.id, { areaId: null }, "test")).toThrow("finish before changing its area");
  });
  it("refuses sensitive prompts before session/context creation", async () => {
    const j = job({ prompt: "Review my mortgage balance $1200" });
    await runSchedulePass(now, deps);
    expect(rows()[0].error).toBe("skipped_policy");
    await expect(runJobNow(owner, j.id, now, deps)).rejects.toMatchObject({ code: "ai_off" });
    expect(deps.createSession).not.toHaveBeenCalled();
  });
  it("records missing or archived areas as policy skips and requires a coordinator", async () => {
    const j = job();
    updateItem(owner, areaId, { settings: { agentMode: null } }, "test");
    await expect(runJobNow(owner, j.id, now, deps)).rejects.toMatchObject({ code: "not_ready" });
    getDb().update(schema.workItems).set({ archived: true }).where(eq(schema.workItems.id, areaId)).run();
    await runSchedulePass(now, deps);
    expect(rows()[0].error).toBe("skipped_policy");
  });
  it("Finance and AI-excluded areas skip before any context or Hermes call", async () => {
    const finance = createItem(owner, { kind: "area", title: "Finance" }, "test");
    updateItem(owner, finance.id, { settings: { agentMode: "devchief", autonomy: "low_risk" } }, "test");
    const j = job({ areaId: finance.id });
    const context = vi.spyOn(deps, "coordinatorFor");
    await runSchedulePass(now, deps);
    expect(jobRow(owner, j.id).lastStatus).toBe("skipped_policy");
    await expect(runJobNow(owner, j.id, now, deps)).rejects.toMatchObject({ status: 409, code: "ai_off" });
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
    updateItem(owner, areaId, { settings: { aiPolicy: "excluded" } }, "test");
    const excluded = job();
    await expect(runJobNow(owner, excluded.id, now, deps)).rejects.toMatchObject({ code: "ai_off" });
  });
  it("no owner is a no-op, and the dispatcher wrapper returns immediately", async () => {
    getDb().delete(schema.users).run();
    setSetting("owner_user_id", null);
    expect(tickSchedules(now, deps)).toBeUndefined();
    await runSchedulePass(now, deps);
    expect(deps.startRun).not.toHaveBeenCalled();
  });
  it("reuses the job session, and uses area model/provider ahead of household defaults", async () => {
    const j = job();
    updateItem(owner, areaId, { settings: { defaultModel: "area-model", defaultProvider: "codex" } }, "test");
    await runJobNow(owner, j.id, now, deps);
    complete("NOTHING_NEW");
    await reconcileScheduledRuns(owner, now, deps);
    await runJobNow(owner, j.id, new Date(now.getTime() + 60_000), deps);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.startRun).mock.calls[0][1]).toMatchObject({
      model: "area-model",
      provider: "codex",
      idempotencyKey: expect.stringContaining(`sched:${j.id}:manual:`),
      instructions: expect.stringContaining("Do not make changes yourself with tools"),
    });
  });
});

describe("reconciliation and digest", () => {
  it("reconciles report proposals into one change, one decision and one refusal, once", async () => {
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    complete(
      proposals([
        { intent: "create_note", title: "Lantern check-in note", text: "Two captures" },
        { intent: "update_status", title: "Mark blocked" },
        { intent: "deploy" },
      ]),
    );
    await reconcileScheduledRuns(owner, now, deps);
    await reconcileScheduledRuns(owner, now, deps);
    const digest = awayDigest(owner, now);
    expect(digest.counts).toEqual({ ran: 1, failed: 0, changes: 1, needsYou: 1, running: 0, waiting: 0 });
    expect(digest.runs[0].refused).toHaveLength(1);
    expect(listItems(owner.id).filter((i) => i.title === "Lantern check-in note")).toHaveLength(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.notify).mock.calls[0][0]).toMatchObject({ scheduledFor: "2026-11-07T13:00:00.000Z", deepLink: "/home" });
    updateItem(owner, areaId, { decision: null }, "test");
    expect(awayDigest(owner, now).counts.needsYou).toBe(0);
    dismissAway(owner, now);
    expect(awayDigest(owner, now).runs).toHaveLength(0);
  });
  it("silent output never notifies; falls back to the assistant transcript if output is absent", async () => {
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    vi.mocked(deps.getRun).mockResolvedValue({ runId: "h", sessionId: "s", status: "completed" });
    vi.mocked(deps.getSessionDetail).mockResolvedValue({ timeline: [{ kind: "assistant", id: "a", text: "NOTHING_NEW" }] } as Awaited<
      ReturnType<SchedulerDeps["getSessionDetail"]>
    >);
    await reconcileScheduledRuns(owner, now, deps);
    expect(jobRow(owner, j.id).lastStatus).toBe("silent");
    expect(awayDigest(owner, now).runs[0].silent).toBe(true);
    expect(deps.notify).not.toHaveBeenCalled();
  });
  it("rechecks changed autonomy before applying and throttles lazy reconciliation", async () => {
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    complete(proposals([{ intent: "create_note", title: "Proposed only" }]));
    updateItem(owner, areaId, { settings: { autonomy: "propose" } }, "test");
    await reconcileScheduledRuns(owner, new Date(now.getTime() + 30_000), deps, true);
    expect(awayDigest(owner, now).counts).toMatchObject({ changes: 0, needsYou: 1 });
    await reconcileScheduledRuns(owner, new Date(now.getTime() + 31_000), deps, true);
    expect(deps.getRun).toHaveBeenCalledTimes(1);
  });
  it("reconcile failures count toward switch-off, excluded areas never receive proposals", async () => {
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    vi.mocked(deps.getRun).mockResolvedValue({ runId: "h", sessionId: "s", status: "failed", error: "Synthetic failure" });
    await reconcileScheduledRuns(owner, now, deps);
    expect(jobRow(owner, j.id).consecutiveFailures).toBe(1);
    const next = new Date(now.getTime() + 60_000);
    await runJobNow(owner, j.id, next, deps);
    updateItem(owner, areaId, { settings: { aiPolicy: "excluded" } }, "test");
    complete(proposals([{ intent: "create_note", title: "Not applied" }]));
    await reconcileScheduledRuns(owner, next, deps);
    expect(listItems(owner.id).some((i) => i.title === "Not applied")).toBe(false);
    expect(awayDigest(owner, next).runs).toHaveLength(0);
  });
  it("five failures disable a job and timeout fails a running reservation", async () => {
    const j = job();
    vi.mocked(deps.startRun).mockRejectedValue(new Error("Synthetic failure"));
    for (let n = 0; n < 5; n++) await runJobNow(owner, j.id, new Date(now.getTime() + n * 60_000), deps);
    expect(jobRow(owner, j.id)).toMatchObject({ enabled: false, consecutiveFailures: 5, lastError: "Switched off after 5 failures in a row" });
    expect(deps.notify).toHaveBeenCalledTimes(5);
    const timeoutJob = job({ title: "Timeout" });
    setSetting("away_max_runs_per_day", 20);
    claimJobSlot(owner, timeoutJob, "timeout-slot", now);
    await reconcileScheduledRuns(owner, new Date(now.getTime() + RUN_TIMEOUT_MS + 1), deps);
    expect(rows().at(-1)).toMatchObject({ status: "failed", error: "Timed out" });
  });
});

describe("policy end to end", () => {
  it.each(PROPOSAL_INTENTS)("enforces low-risk and propose for %s without lifecycle changes", (intent) => {
    const target = createItem(owner, { kind: "thread", title: "Task", parentId: areaId }, "test");
    const p: Proposal = { intent, itemId: target.id, title: "Proposal", text: "Next step", why: "Check" };
    const low = applyProposals(owner, areaId, "Check", "devchief", [p]);
    expect(low.changes).toHaveLength(LOW_RISK_INTENTS.includes(intent) ? 1 : 0);
    expect(low.decisions).toHaveLength(!LOW_RISK_INTENTS.includes(intent) && !NEVER_INTENTS.includes(intent) ? 1 : 0);
    expect(low.refused).toHaveLength(NEVER_INTENTS.includes(intent) ? 1 : 0);
    expect(listItems(owner.id).find((i) => i.id === target.id)).toMatchObject({ status: "captured", archived: false, parentId: areaId });
    updateItem(owner, target.id, { decision: null }, "test");
    updateItem(owner, areaId, { settings: { autonomy: "propose" } }, "test");
    const proposed = applyProposals(owner, areaId, "Check", "devchief", [p]);
    expect(proposed.changes).toHaveLength(0);
    expect(proposed.decisions).toHaveLength(NEVER_INTENTS.includes(intent) ? 0 : 1);
  });
  it("refuses outside targets, missing titles/text, and existing decisions without overwriting", () => {
    const other = createItem(owner, { kind: "area", title: "Other" }, "test");
    const out = applyProposals(owner, areaId, "Check", "devchief", [
      { intent: "create_note", itemId: other.id, title: "No" },
      { intent: "create_thread" },
      { intent: "update_next_action" },
    ]);
    expect(out.refused.map((r) => r.label)).toEqual(
      expect.arrayContaining(["create note: outside this area", "create thread: missing title", "update next action: missing text"]),
    );
    const target = createItem(owner, { kind: "thread", title: "Target", parentId: areaId }, "test");
    updateItem(owner, target.id, { decision: { question: "Existing?" } }, "test");
    const fallback = applyProposals(owner, areaId, "Check", "devchief", [
      { intent: "update_status", itemId: target.id },
      { intent: "archive", itemId: target.id },
    ]);
    expect(fallback.decisions[0].itemId).toBe(areaId);
    expect(fallback.refused[0].label).toContain("a decision is already open");
  });
  it("agent writes have Activity attribution and 7-day undo, including Inbox captures", () => {
    applyProposals(owner, areaId, "Check", "devchief", [{ intent: "create_note", title: "Agent note" }]);
    const note = listItems(owner.id).find((i) => i.title === "Agent note")!;
    expect(note.createdVia).toBe("agent:devchief");
    const activity = listActivity(owner, { item: note.id }).items.find((a) => a.undoOpId)!;
    expect(activity.via).toBe("devchief");
    undoOp(owner, activity.undoOpId!, "test", new Date(Date.now() + 86_400_000));
    expect(listItems(owner.id).some((i) => i.id === note.id)).toBe(false);
    applyProposals(owner, areaId, "Check", "devchief", [{ intent: "file_to_inbox", title: "Capture", text: "Details" }]);
    const op = getDb()
      .select()
      .from(schema.workOps)
      .all()
      .find((o) => o.payload.includes("scheduledCapture"))!;
    expect(op.via).toBe("agent:devchief");
    undoOp(owner, op.id, "test", new Date(Date.now() + 86_400_000));
    expect(getDb().select().from(schema.workInbox).all()[0].dismissedAt).toBeTruthy();
    expect(getDb().select().from(schema.aiJobs).all()).toHaveLength(0);
  });
  it("an agent-token MCP call cannot escalate autonomy or change any area setting", async () => {
    const { token } = mintAgentToken(owner, { name: "Synthetic", profile: "devchief", scopes: ["work.write"] }, "test");
    const req = new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "jarvis_update_item", arguments: { id: areaId, settings: { autonomy: "low_risk", aiPolicy: "allowed" } } },
      }),
    });
    updateItem(owner, areaId, { settings: { autonomy: "propose" } }, "test");
    const response = await mcp(req);
    expect((await response.json()).result.isError).toBe(true);
    expect(listItems(owner.id).find((i) => i.id === areaId)!.settings!.autonomy).toBe("propose");
  });
});

describe("#230 follow-ups", () => {
  it("approval/clarify shows as Needs you (not running), notifies once and clears on resume", async () => {
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    vi.mocked(deps.getRun).mockResolvedValue({ runId: "h", sessionId: "s", status: "waiting_for_approval" });
    await reconcileScheduledRuns(owner, now, deps);
    await reconcileScheduledRuns(owner, new Date(now.getTime() + 60_000), deps);
    expect(rows()[0]).toMatchObject({ status: "running", summary: "Waiting for you" });
    const digest = awayDigest(owner, now);
    expect(digest.runs[0].waiting).toBe(true);
    expect(digest.counts).toMatchObject({ running: 0, waiting: 1, needsYou: 1 });
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.notify).mock.calls[0][0]).toMatchObject({ dedupeKey: `away-wait:${rows()[0].id}` });
    vi.mocked(deps.getRun).mockResolvedValue({ runId: "h", sessionId: "s", status: "running" });
    await reconcileScheduledRuns(owner, new Date(now.getTime() + 120_000), deps);
    expect(awayDigest(owner, now).counts).toMatchObject({ running: 1, waiting: 0 });
    vi.mocked(deps.getRun).mockResolvedValue({ runId: "h", sessionId: "s", status: "waiting_for_approval" });
    await reconcileScheduledRuns(owner, new Date(now.getTime() + 180_000), deps);
    await reconcileScheduledRuns(owner, new Date(now.getTime() + RUN_TIMEOUT_MS + 1), deps);
    expect(rows()[0]).toMatchObject({ status: "failed", error: "Timed out waiting for your approval" });
  });
  it("dismissing while a run is active still surfaces its result when it finishes", async () => {
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    const later = new Date(now.getTime() + 5 * 60_000);
    dismissAway(owner, new Date(now.getTime() + 60_000));
    expect(awayDigest(owner, later).counts.running).toBe(1);
    complete(proposals([{ intent: "create_note", title: "Finished after dismiss" }]));
    await reconcileScheduledRuns(owner, later, deps);
    const digest = awayDigest(owner, later);
    expect(digest.runs).toHaveLength(1);
    expect(digest.counts).toMatchObject({ ran: 1, changes: 1 });
    dismissAway(owner, new Date(later.getTime() + 1));
    expect(awayDigest(owner, later).runs).toHaveLength(0);
  });
  it("deleting a job keeps its run ledger: the daily cap and digest still count it", async () => {
    setSetting("away_max_runs_per_day", 1);
    const j = job();
    await runJobNow(owner, j.id, now, deps);
    complete("Done.");
    await reconcileScheduledRuns(owner, now, deps);
    deleteJob(owner, j.id, "test", now);
    expect(listSchedules(owner, now).jobs.some((x) => x.id === j.id)).toBe(false);
    expect(() => jobRow(owner, j.id)).toThrow();
    expect(runCaps(owner, now).runsToday).toBe(1);
    expect(awayDigest(owner, now).runs.map((r) => r.jobTitle)).toEqual(["Check in"]);
    // "Undo" re-creates the job; the cap is not reset.
    const again = job();
    await expect(runJobNow(owner, again.id, now, deps)).rejects.toMatchObject({ code: "daily_cap" });
  });
  it("propose-only decisions persist the proposed content and name the original target on fallback", async () => {
    updateItem(owner, areaId, { settings: { autonomy: "propose" } }, "test");
    const target = createItem(owner, { kind: "thread", title: "Lantern thread", parentId: areaId }, "test");
    const note = applyProposals(owner, areaId, "Overnight", "devchief", [
      { intent: "create_note", itemId: target.id, title: "Morning brief", text: "Line one\nLine two", why: "Triage" },
    ]);
    expect(note.decisions[0]).toMatchObject({ itemId: target.id });
    const saved = listItems(owner.id).find((i) => i.id === target.id)!.decision!;
    expect(saved.detail).toBe("Morning brief\n\nLine one\nLine two");
    const entry = listDecisions(owner).entries.find((e) => e.itemId === target.id)!;
    expect(entry.detail).toContain("Line two");
    // Target already has a decision: archive is asked on the area, naming the thread, never as "archive the area".
    const out = applyProposals(owner, areaId, "Overnight", "devchief", [{ intent: "archive", itemId: target.id, why: "Stale" }]);
    expect(out.decisions[0]).toMatchObject({ itemId: areaId, targetId: target.id, targetTitle: "Lantern thread" });
    const q = listItems(owner.id).find((i) => i.id === areaId)!.decision!.question;
    expect(q).toContain("archive “Lantern thread”");
    expect(q).toContain("already has an open decision");
    expect(q).not.toContain("proposes: archive");
    expect(listItems(owner.id).find((i) => i.id === target.id)).toMatchObject({ archived: false });
  });
  it("while a scheduled run is active, the profile's MCP direct writes are refused; proposals still work", async () => {
    const { token } = mintAgentToken(owner, { name: "Sched", profile: "devchief", scopes: ["work.write", "decisions.write"] }, "test");
    const call = async (name: string, args: Record<string, unknown>) => {
      const req = new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      return (await (await mcp(req)).json()).result as { isError?: boolean; content: { text: string }[] };
    };
    const j = job();
    const row = claimJobSlot(owner, j, "slot-mcp", new Date())!;
    getDb().update(R).set({ profile: "devchief" }).where(eq(R.id, row.id)).run();
    const refused = await call("jarvis_add_note", { itemId: areaId, title: "Direct write" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("scheduled_run");
    expect(listItems(owner.id).some((i) => i.title === "Direct write")).toBe(false);
    expect((await call("jarvis_raise_decision", { itemId: areaId, question: "Ok?" })).isError).toBeFalsy();
    getDb().update(R).set({ status: "done" }).where(eq(R.id, row.id)).run();
    expect((await call("jarvis_add_note", { itemId: areaId, title: "Direct write" })).isError).toBeFalsy();
  });
});
