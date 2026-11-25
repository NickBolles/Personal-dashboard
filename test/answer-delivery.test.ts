/**
 * Task threads, step 5: the owner's answer reaches the agent. Recorded at once, posted to the task's chat after
 * the Undo window, "Delivered" only once the chat confirms it; Undo in time sends nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { answerDecisionRef, raiseDecision } from "@/server/work/decision-store";
import { registerAgentRun } from "@/server/work/registered-runs";
import { deliverAnswers, type DeliveryDeps } from "@/server/work/answer-delivery";
import { taskTimeline } from "@/server/work/tasks";
import { DELIVERY_DELAY_MS, deliveryText } from "@/lib/cw-decisions";
import { maskAccountNumbers } from "@/lib/ai-redact";
import type { OpOut } from "@/server/work/store";
import type { TimelineItem } from "@/lib/hermes";
import type { WorkItem } from "@/lib/work";

const cid = "test";
let owner: CurrentUser;
let task: WorkItem;
let chat: TimelineItem[];
let hermes: Map<string, { status: string; pendingSteer?: string; forgotten?: true }>;

beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
  const area = store.createItem(owner, { kind: "area", title: "Home", parentId: null }, cid);
  task = store.createItem(owner, { kind: "thread", title: "Compare desk frames", parentId: area.id }, cid);
  chat = [];
  hermes = new Map();
});

const setPrimary = (sessionId: string | null) =>
  getDb().update(schema.workItems).set({ primarySessionId: sessionId }).where(eq(schema.workItems.id, task.id)).run();
const row = (ref: string) =>
  getDb()
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.seq, Number(ref.slice(2))))
    .get()!;
function deps(over: Partial<DeliveryDeps> = {}) {
  const startRun = vi.fn(async (_u: unknown, r: { input: string }) => {
    chat.push({ kind: "user", id: `u${chat.length}`, text: r.input });
    return { runId: "run_x" } as never;
  });
  const steerRun = vi.fn(async () => ({}) as never);
  // Hermes's view of a run: by default what Jarvis recorded; a test can say otherwise.
  const reconcile = vi.fn(async (runId: string) => ({
    status: hermes.get(runId)?.status ?? getDb().select().from(schema.runs).where(eq(schema.runs.runId, runId)).get()?.status ?? "completed",
    pendingSteer: hermes.get(runId)?.pendingSteer,
    ...(hermes.get(runId)?.forgotten ? { forgotten: true as const } : {}),
  }));
  const d: DeliveryDeps = {
    startRun: startRun as never,
    steerRun: steerRun as never,
    reconcile,
    sessionDetail: async () => ({ timeline: chat }),
    user: () => owner,
    ...over,
  };
  return { d, startRun, steerRun, reconcile };
}
const ask = () =>
  raiseDecision(
    owner.id,
    task.id,
    { question: "What is your budget ceiling?", choices: ["$350", "$300"] },
    { raisedBy: "agent:homechief", correlationId: cid },
  );
const after = (ms: number) => new Date(Date.now() + ms);

describe("an answer reaches the agent's chat", () => {
  it("is recorded at once, posted after the Undo window, and reads Delivered once it is seen in the chat", async () => {
    setPrimary("sess-task");
    const q = ask();
    const out: OpOut = {};
    const { decision } = answerDecisionRef(owner.id, q.ref, "$350", "queue", cid, out);
    // Recorded at once; the agent gets it after the Undo window.
    expect(decision).toMatchObject({ state: "answered", answeredChoice: "$350", delivery: { state: "pending" } });
    const { d, startRun } = deps();
    expect(await deliverAnswers(new Date(), d)).toEqual({ sent: 0, delivered: 0, failed: 0 });
    expect(startRun).not.toHaveBeenCalled();
    // After the window: posted into the task's chat, as the answer to that question.
    expect(await deliverAnswers(after(DELIVERY_DELAY_MS + 1), d)).toMatchObject({ sent: 1 });
    expect(startRun).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "sess-task",
        input: deliveryText(q.ref, "What is your budget ceiling?", "$350"),
        idempotencyKey: `answer:${row(q.ref).id}`,
      }),
      expect.any(String),
    );
    expect(row(q.ref).deliveryState).toBe("sent");
    // Read back on the next pass: now it is delivered, and the timeline says so.
    expect(await deliverAnswers(after(DELIVERY_DELAY_MS + 2_000), d)).toMatchObject({ delivered: 1 });
    expect(row(q.ref)).toMatchObject({ deliveryState: "delivered" });
    expect(taskTimeline(owner, task.id).moments.find((m) => m.label === "Decided")?.text).toBe("What is your budget ceiling? → $350 · delivered");
    // Nothing is posted twice.
    await deliverAnswers(after(DELIVERY_DELAY_MS + 60_000), d);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("Undo inside the window sends nothing", async () => {
    setPrimary("sess-task");
    const q = ask();
    const out: OpOut = {};
    answerDecisionRef(owner.id, q.ref, "$350", "queue", cid, out);
    store.undoOp(owner, out.op!.id, cid);
    expect(row(q.ref)).toMatchObject({ state: "open", deliveryState: null });
    const { d, startRun } = deps();
    await deliverAnswers(after(DELIVERY_DELAY_MS + 1), d);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("a turn in flight takes it as guidance, delivered once that turn ends having used it; a turn paused on an approval is waited for", async () => {
    setPrimary("sess-task");
    const q = ask();
    answerDecisionRef(owner.id, q.ref, "$300", "queue", cid);
    const turn = (status: string) =>
      getDb()
        .insert(schema.runs)
        .values({ runId: "hr1", userId: owner.id, sessionId: "sess-task", status, idempotencyKey: "k-hr1" })
        .onConflictDoUpdate({ target: schema.runs.runId, set: { status } })
        .run();
    turn("waiting_for_approval");
    const { d, steerRun, startRun } = deps();
    await deliverAnswers(after(DELIVERY_DELAY_MS + 1), d);
    expect(steerRun).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
    expect(row(q.ref).deliveryState).toBe("pending");
    turn("running");
    await deliverAnswers(after(DELIVERY_DELAY_MS + 61_000 + 1), d);
    expect(steerRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), "hr1", deliveryText(q.ref, "What is your budget ceiling?", "$300"), expect.any(String));
    // Accepted is only queued: still sent while the turn runs, delivered once it ends without handing it back.
    expect(row(q.ref)).toMatchObject({ deliveryState: "sent", deliveryRun: "hr1" });
    await deliverAnswers(after(DELIVERY_DELAY_MS + 62_000), d);
    expect(row(q.ref).deliveryState).toBe("sent");
    hermes.set("hr1", { status: "completed" });
    // A turn still going is looked at again 30 s later.
    await deliverAnswers(after(DELIVERY_DELAY_MS + 63_000), d);
    expect(row(q.ref).deliveryState).toBe("sent");
    await deliverAnswers(after(DELIVERY_DELAY_MS + 93_000), d);
    expect(row(q.ref).deliveryState).toBe("delivered");
  });

  it("guidance waiting on a busy turn is checked again later, behind the rest; a turn Hermes forgot is not called delivered", async () => {
    setPrimary("sess-task");
    const q = ask();
    answerDecisionRef(owner.id, q.ref, "$300", "queue", cid);
    getDb().insert(schema.runs).values({ runId: "hr4", userId: owner.id, sessionId: "sess-task", status: "running", idempotencyKey: "k-hr4" }).run();
    const { d } = deps();
    const t1 = after(DELIVERY_DELAY_MS + 1);
    await deliverAnswers(t1, d);
    expect(row(q.ref).deliveryState).toBe("sent");
    const t2 = after(DELIVERY_DELAY_MS + 2_000);
    await deliverAnswers(t2, d);
    // Still running: pushed back, not due on every pass.
    expect(Date.parse(row(q.ref).deliverAfter!)).toBeGreaterThan(t2.getTime());
    hermes.set("hr4", { status: "interrupted", forgotten: true });
    await deliverAnswers(after(DELIVERY_DELAY_MS + 60_000), d);
    expect(row(q.ref)).toMatchObject({ deliveryState: "failed", deliveryError: "Couldn't confirm the agent read it" });
  });

  it("guidance the turn handed back unread is posted as the next message", async () => {
    setPrimary("sess-task");
    const q = ask();
    answerDecisionRef(owner.id, q.ref, "$300", "queue", cid);
    getDb().insert(schema.runs).values({ runId: "hr2", userId: owner.id, sessionId: "sess-task", status: "running", idempotencyKey: "k-hr2" }).run();
    const { d, steerRun, startRun } = deps();
    await deliverAnswers(after(DELIVERY_DELAY_MS + 1), d);
    expect(steerRun).toHaveBeenCalledTimes(1);
    const text = deliveryText(q.ref, "What is your budget ceiling?", "$300");
    hermes.set("hr2", { status: "completed", pendingSteer: text });
    getDb().update(schema.runs).set({ status: "completed" }).where(eq(schema.runs.runId, "hr2")).run();
    await deliverAnswers(after(DELIVERY_DELAY_MS + 2_000), d);
    expect(row(q.ref)).toMatchObject({ deliveryState: "pending", deliveryRun: null });
    await deliverAnswers(after(DELIVERY_DELAY_MS + 3_000), d);
    expect(startRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ input: text }), expect.any(String));
    await deliverAnswers(after(DELIVERY_DELAY_MS + 4_000), d);
    expect(row(q.ref).deliveryState).toBe("delivered");
  });

  it("asks Hermes before steering: a turn Jarvis still thinks is running but has ended gets a new message", async () => {
    setPrimary("sess-task");
    const q = ask();
    answerDecisionRef(owner.id, q.ref, "$350", "queue", cid);
    getDb().insert(schema.runs).values({ runId: "hr3", userId: owner.id, sessionId: "sess-task", status: "running", idempotencyKey: "k-hr3" }).run();
    hermes.set("hr3", { status: "completed" });
    const { d, steerRun, startRun } = deps();
    await deliverAnswers(after(DELIVERY_DELAY_MS + 1), d);
    expect(steerRun).not.toHaveBeenCalled();
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("reads back the message as the chat shows it, with account numbers masked", async () => {
    setPrimary("sess-task");
    const q = raiseDecision(
      owner.id,
      task.id,
      { question: "Which account pays it?", choices: ["Checking"] },
      { raisedBy: "agent:homechief", correlationId: cid },
    );
    answerDecisionRef(owner.id, q.ref, "Account 12345678", "queue", cid);
    const { d } = deps({
      startRun: vi.fn(async (_u: unknown, r: { input: string }) => {
        chat.push({ kind: "user", id: "u0", text: maskAccountNumbers(r.input) });
        return { runId: "run_y" } as never;
      }) as never,
    });
    await deliverAnswers(after(DELIVERY_DELAY_MS + 1), d);
    await deliverAnswers(after(DELIVERY_DELAY_MS + 2_000), d);
    expect(row(q.ref).deliveryState).toBe("delivered");
  });

  it("a post that is never seen in the chat reads not delivered; a failed post is retried, then given up", async () => {
    setPrimary("sess-task");
    const q = ask();
    answerDecisionRef(owner.id, q.ref, "$350", "queue", cid);
    const lost = deps({ startRun: vi.fn(async () => ({ runId: "r" })) as never });
    await deliverAnswers(after(DELIVERY_DELAY_MS + 1), lost.d);
    expect(row(q.ref).deliveryState).toBe("sent");
    await deliverAnswers(after(DELIVERY_DELAY_MS + 4 * 60_000), lost.d);
    expect(row(q.ref)).toMatchObject({ deliveryState: "failed", deliveryError: "Not seen in the chat" });
    expect(taskTimeline(owner, task.id).moments.find((m) => m.label === "Decided")?.text).toBe("What is your budget ceiling? → $350 · not delivered");

    const q2 = raiseDecision(owner.id, task.id, { question: "Which colour?", choices: ["Oak", "Walnut"] }, { raisedBy: "agent:homechief", correlationId: cid });
    answerDecisionRef(owner.id, q2.ref, "Oak", "queue", cid);
    const down = deps({ startRun: vi.fn(async () => Promise.reject(new Error("Hermes is not answering"))) as never });
    await deliverAnswers(after(DELIVERY_DELAY_MS + 1), down.d);
    expect(row(q2.ref)).toMatchObject({ deliveryState: "pending", deliveryError: "Hermes is not answering" });
    await deliverAnswers(after(31 * 60_000 + 61_000), down.d);
    expect(row(q2.ref).deliveryState).toBe("failed");
  });

  it("with no chat to post in, nothing is queued; an answer given in the chat itself is not posted back", async () => {
    const q = ask();
    expect(answerDecisionRef(owner.id, q.ref, "$350", "queue", cid).decision.delivery).toBeNull();
    // The raising run's chat is used when the task has none of its own.
    const { runId } = registerAgentRun(owner, "homechief", { itemId: task.id, title: "Desk research", hermesSessionId: "sess-run" }, cid);
    const q2 = raiseDecision(
      owner.id,
      task.id,
      { question: "Which colour?", choices: ["Oak", "Walnut"], runId },
      { raisedBy: "agent:homechief", correlationId: cid },
    );
    expect(answerDecisionRef(owner.id, q2.ref, "Oak", "queue", cid).decision.delivery).toMatchObject({ state: "pending" });
    expect(row(q2.ref).deliverySession).toBe("sess-run");
    setPrimary("sess-task");
    const q3 = raiseDecision(owner.id, task.id, { question: "Delivery day?", choices: ["Mon", "Tue"] }, { raisedBy: "agent:homechief", correlationId: cid });
    expect(answerDecisionRef(owner.id, q3.ref, "Mon", "chat", cid).decision.delivery).toBeNull();
  });
});
