import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { answerDecisionRef, raiseDecision } from "@/server/work/decision-store";
import { registerAgentRun, finishRegisteredRun } from "@/server/work/registered-runs";
import { __resetSessionEnd, markEndedSessionRuns, sessionEnded } from "@/server/work/session-end";
import { resumeInterruptedRuns, resumePrompt } from "@/server/work/resume-runs";
import { decisionPushActions } from "@/server/work/cw-push-actions";
import { withVia } from "@/server/work/actor";

const cid = "test";
let owner: CurrentUser;
let itemId: string;
const runRow = (id: string) => getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get()!;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  __setTestDatabase();
  __resetSessionEnd();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
  const area = store.createItem(owner, { parentId: null, kind: "area", title: "Area resume" }, cid);
  itemId = store.createItem(owner, { parentId: area.id, kind: "thread", title: "Resume things" }, cid).id;
});

describe("session end → interrupted", () => {
  it("only real end reasons count (compression/branch continue elsewhere)", () => {
    expect(sessionEnded({ endReason: "cli_close" })).toBe(true);
    expect(sessionEnded({ endReason: "agent_close" })).toBe(true);
    expect(sessionEnded({ endReason: "compression" })).toBe(false);
    expect(sessionEnded({ endReason: "branched" })).toBe(false);
    expect(sessionEnded({ endReason: null })).toBe(false);
    expect(sessionEnded(null)).toBe(false);
  });

  it("marks open runs of an ended session interrupted (one GET per session) and leaves the rest alone", async () => {
    const t0 = new Date(Date.now() - 60 * 60_000);
    const a = registerAgentRun(owner, "chiefofstaff", { itemId, title: "Lane A", hermesSessionId: "sess-ended" }, cid, "tok", t0);
    const b = registerAgentRun(owner, "chiefofstaff", { itemId, title: "Lane B", hermesSessionId: "sess-ended" }, cid, "tok", t0);
    const c = registerAgentRun(owner, "chiefofstaff", { itemId, title: "Lane C", hermesSessionId: "sess-live" }, cid, "tok", t0);
    const d = registerAgentRun(owner, "chiefofstaff", { itemId, title: "Lane D", hermesSessionId: "sess-compressed" }, cid, "tok", t0);
    const e = registerAgentRun(owner, "chiefofstaff", { itemId, title: "Lane E", hermesSessionId: "sess-ended", delegationId: "sub:p:1" }, cid, null, t0);
    const lookup = vi.fn(async (profile: string | null, id: string) => {
      expect(profile).toBe("chiefofstaff");
      if (id === "sess-ended") return { endReason: "cli_close", lastActiveAt: ago(30 * 60_000) };
      if (id === "sess-compressed") return { endReason: "compression", lastActiveAt: ago(30 * 60_000) };
      return { endReason: null, lastActiveAt: ago(1000) };
    });
    const res = await markEndedSessionRuns(new Date(), lookup);
    expect(res).toEqual({ checked: 3, marked: 2 });
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(runRow(a.runId)).toMatchObject({ state: "interrupted" });
    expect(runRow(a.runId).interruptedAt).toBeTruthy();
    expect(runRow(b.runId).state).toBe("interrupted");
    expect(runRow(c.runId).state).toBe("running");
    expect(runRow(d.runId).state).toBe("running");
    // automatic sub-agent mirrors are the mirror reconcile's job
    expect(runRow(e.runId).state).toBe("running");
    const events = getDb().select().from(schema.runEvents).where(eq(schema.runEvents.runId, a.runId)).all();
    expect(events.map((x) => x.type)).toContain("interrupted");
    // the CW-5 push goes out once for the burst
    expect(
      getDb()
        .select()
        .from(schema.notifications)
        .all()
        .filter((n) => n.type === "cw.session_ended"),
    ).toHaveLength(1);
    // throttled: a second pass right away does nothing
    expect(await markEndedSessionRuns(new Date(), lookup)).toEqual({ checked: 0, marked: 0 });
  });

  it("a long session list rotates: the next pass checks the sessions the last one skipped", async () => {
    const t0 = new Date(Date.now() - 60 * 60_000);
    for (let i = 0; i < 12; i++) registerAgentRun(owner, "default", { itemId, title: `Lane ${i}`, hermesSessionId: `sess-${i}` }, cid, "tok", t0);
    const seen: string[] = [];
    const lookup = async (_p: string | null, id: string) => {
      seen.push(id);
      return { endReason: null, lastActiveAt: ago(1000) };
    };
    await markEndedSessionRuns(new Date(), lookup);
    expect(seen).toHaveLength(10);
    const first = new Set(seen);
    seen.length = 0;
    await markEndedSessionRuns(new Date(Date.now() + 6 * 60_000), lookup);
    expect(seen.slice(0, 2).every((id) => !first.has(id))).toBe(true);
  });

  it("a session that only just closed, or a run that heartbeated after it, stays running; lookup errors are not guesses", async () => {
    const recent = registerAgentRun(
      owner,
      "chiefofstaff",
      { itemId, title: "Just closed", hermesSessionId: "sess-recent" },
      cid,
      "tok",
      new Date(Date.now() - 60 * 60_000),
    );
    const alive = registerAgentRun(owner, "default", { itemId, title: "Alive", hermesSessionId: "sess-old" }, cid, "tok");
    const down = registerAgentRun(owner, "default", { itemId, title: "Down", hermesSessionId: "sess-down" }, cid, "tok");
    const res = await markEndedSessionRuns(new Date(), async (profile, id) => {
      expect(profile).toBeNull();
      if (id === "sess-recent") return { endReason: "agent_close", lastActiveAt: ago(60_000) };
      if (id === "sess-old") return { endReason: "agent_close", lastActiveAt: ago(30 * 60_000) };
      throw new Error("Hermes down");
    });
    expect(res.marked).toBe(0);
    for (const r of [recent, alive, down]) expect(runRow(r.runId).state).toBe("running");
  });
});

describe("Resume all", () => {
  function interrupted(title: string, session: string | undefined, profile = "chiefofstaff") {
    const r = registerAgentRun(owner, profile, { itemId, title, hermesSessionId: session }, cid, "tok");
    finishRegisteredRun(owner, r.runId, "interrupted", "session ended", new Date());
    return r;
  }

  it("sends ONE resume prompt per session through the run path, tracks the agent's session on its profile, and skips the rest", async () => {
    const a = interrupted("Lane A", "sess-1");
    const b = interrupted("Lane B", "sess-1");
    const c = interrupted("Lane C", "sess-2", "default");
    const live = registerAgentRun(owner, "chiefofstaff", { itemId, title: "Still going", hermesSessionId: "sess-3" }, cid, "tok");
    const noSession = interrupted("No session", undefined);
    const start = vi.fn(async () => ({}));
    const steer = vi.fn(async () => ({}));
    const track = vi.fn(async () => undefined);
    const { results } = await resumeInterruptedRuns(owner, [a.ref, b.ref, c.ref, live.ref, noSession.ref, "R-999"], cid, { start, steer, track });
    expect(start).toHaveBeenCalledTimes(2);
    const first = (start.mock.calls[0] as unknown as [CurrentUser, { sessionId: string; input: string; idempotencyKey: string }])[1];
    expect(first.sessionId).toBe("sess-1");
    expect(first.input).toBe(
      resumePrompt([
        { ref: a.ref, title: "Lane A" },
        { ref: b.ref, title: "Lane B" },
      ]),
    );
    expect(first.input).toContain("jarvis_run_update");
    expect(track).toHaveBeenCalledWith(owner, "chiefofstaff", "sess-1", cid);
    expect(track).toHaveBeenCalledWith(owner, null, "sess-2", cid);
    expect(steer).not.toHaveBeenCalled();
    expect(results).toEqual(
      expect.arrayContaining([
        { ref: a.ref, ok: true, sent: "run" },
        { ref: b.ref, ok: true, sent: "run" },
        { ref: c.ref, ok: true, sent: "run" },
        { ref: live.ref, ok: false, reason: "not_interrupted" },
        { ref: noSession.ref, ok: false, reason: "no_session" },
        { ref: "R-999", ok: false, reason: "not_found" },
      ]),
    );
    // Same interruption: claimed already, nothing is sent again (even if a turn is now live on the session).
    getDb().insert(schema.runs).values({ runId: "hr-live", sessionId: "sess-1", userId: owner.id, idempotencyKey: "k-live", status: "running" }).run();
    const again = await resumeInterruptedRuns(owner, [a.ref, b.ref], cid, { start, steer, track });
    expect(again.results).toEqual([
      { ref: a.ref, ok: true, sent: "already" },
      { ref: b.ref, ok: true, sent: "already" },
    ]);
    expect(start).toHaveBeenCalledTimes(2);
    expect(steer).not.toHaveBeenCalled();
  });

  it("steers a turn still in flight on the session instead of starting another", async () => {
    const a = interrupted("Lane A", "sess-9");
    getDb().insert(schema.runs).values({ runId: "hr-1", sessionId: "sess-9", userId: owner.id, idempotencyKey: "k1", status: "running" }).run();
    const start = vi.fn(async () => ({}));
    const steer = vi.fn(async () => ({}));
    const { results } = await resumeInterruptedRuns(owner, [a.ref], cid, { start, steer, track: async () => undefined });
    expect(steer).toHaveBeenCalledWith(owner, "hr-1", expect.stringContaining(a.ref), cid);
    expect(start).not.toHaveBeenCalled();
    expect(results).toEqual([{ ref: a.ref, ok: true, sent: "steer" }]);
  });

  it("agents can't resume (owner only) and a failed send is reported per run", async () => {
    const a = interrupted("Lane A", "sess-1");
    await expect(withVia("agent:chiefofstaff", () => resumeInterruptedRuns(owner, [a.ref], cid, { start: async () => ({}) }))).rejects.toMatchObject({
      code: "owner_only",
    });
    const { results } = await resumeInterruptedRuns(owner, [a.ref], cid, {
      start: async () => {
        throw new Error("boom");
      },
      track: async () => undefined,
    });
    expect(results).toEqual([{ ref: a.ref, ok: false, reason: "send_failed" }]);
    // the failed send released its claim: a retry goes out
    const start = vi.fn(async () => ({}));
    expect((await resumeInterruptedRuns(owner, [a.ref], cid, { start, track: async () => undefined })).results).toEqual([
      { ref: a.ref, ok: true, sent: "run" },
    ]);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("one-tap push answers", () => {
  it("only open low-risk decisions with choices get actions (recommended first); risk-flagged never", () => {
    const low = raiseDecision(
      owner.id,
      itemId,
      { question: "Rename it?", choices: ["No", "Yes", "Later"], recommended: "Yes" },
      { raisedBy: "agent:x", correlationId: cid },
    );
    const risky = raiseDecision(
      owner.id,
      itemId,
      { question: "Rotate key?", choices: ["Rotate"], risk: ["credential"] },
      { raisedBy: "agent:x", correlationId: cid },
    );
    const open = raiseDecision(owner.id, itemId, { question: "Thoughts?" }, { raisedBy: "agent:x", correlationId: cid });
    expect(decisionPushActions(owner.id, `cw:decision:${low.ref}`)).toEqual({
      ref: low.ref,
      actions: [
        { action: "answer:0", title: "Yes" },
        { action: "answer:1", title: "No" },
      ],
      answers: { "answer:0": "Yes", "answer:1": "No" },
    });
    expect(decisionPushActions(owner.id, `cw:decision:${risky.ref}`)).toBeNull();
    expect(decisionPushActions(owner.id, `cw:decision:${open.ref}`)).toBeNull();
    expect(decisionPushActions(owner.id, "cw:digest:x")).toBeNull();
    answerDecisionRef(owner.id, low.ref, "Yes", "queue", cid);
    expect(decisionPushActions(owner.id, `cw:decision:${low.ref}`)).toBeNull();
  });

  it("credential-like or account-number choices suppress the actions", () => {
    const key = raiseDecision(
      owner.id,
      itemId,
      { question: "Which one?", choices: [`Use ${["ghp", "x7Qm2Lp9Vt4Rz8Kw3Nb6Hc1Jd5Fg0Sy2Ae7U"].join("_")}`, "Skip"] },
      { raisedBy: "agent:x", correlationId: cid },
    );
    const acct = raiseDecision(
      owner.id,
      itemId,
      { question: "Which account?", choices: ["4111111111111111", "Other"] },
      { raisedBy: "agent:x", correlationId: cid },
    );
    expect(decisionPushActions(owner.id, `cw:decision:${key.ref}`)).toBeNull();
    expect(decisionPushActions(owner.id, `cw:decision:${acct.ref}`)).toBeNull();
  });

  it("the answer route refuses a push answer on a risk-flagged decision or with a non-choice", () => {
    const risky = raiseDecision(
      owner.id,
      itemId,
      { question: "Rotate key?", choices: ["Rotate"], risk: ["credential"] },
      { raisedBy: "agent:x", correlationId: cid },
    );
    const low = raiseDecision(owner.id, itemId, { question: "Rename it?", choices: ["Yes", "No"] }, { raisedBy: "agent:x", correlationId: cid });
    expect(() => answerDecisionRef(owner.id, risky.ref, "Rotate", "push", cid)).toThrow(/confirmed answer/);
    expect(() => answerDecisionRef(owner.id, low.ref, "Something else", "push", cid)).toThrow(/confirmed answer/);
    expect(answerDecisionRef(owner.id, low.ref, "Yes", "push", cid).decision.state).toBe("answered");
    // the queue (with Confirm in the app) still answers risk-flagged decisions
    expect(answerDecisionRef(owner.id, risky.ref, "Rotate", "queue", cid).decision.state).toBe("answered");
  });
});
