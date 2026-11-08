import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { createItem, undoOp, updateItem } from "@/server/work/store";
import { createItemFromFeedback, deleteFeedback, feedbackRow, getFeedback, patchFeedback, rateMessage, F } from "@/server/feedback/store";

let user: CurrentUser;
let area: string;
const input = {
  sessionId: "loc_feedback",
  messageId: "m1",
  surface: "chat" as const,
  rating: "down" as const,
  reasons: ["wrong" as const],
  note: "Original note",
  text: "Original excerpt",
  tools: ["terminal"],
  model: "original-model",
};
const rate = (patch: Partial<Parameters<typeof rateMessage>[1]> = {}) => rateMessage(user, { ...input, ...patch }, "test");

beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  user = resolveUser(new Headers(), createSession(id).token)!;
  area = createItem(user, { kind: "area", title: "General Dev" }, "test").id;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in undo tests");
    }),
  );
});

function reviewed() {
  const feedback = rate();
  const item = createItem(user, { kind: "thread", parentId: area, title: "Linked issue" }, "test");
  getDb()
    .update(F)
    .set({
      status: "fixed",
      triagedAt: "2026-11-01T01:00:00Z",
      triageRunId: "triage-original",
      itemId: item.id,
      fixRequestedAt: "2026-11-01T02:00:00Z",
      areaId: area,
      profile: "review-profile",
    })
    .where(eq(F.id, feedback.id))
    .run();
  return feedbackRow(user, feedback.id);
}

afterEach(() => vi.unstubAllGlobals());

describe("feedback undo full-row snapshots", () => {
  it("delete followed by the existing UI's replay restores the same id and every review/context field", () => {
    const before = reviewed();
    const deleted = deleteFeedback(user, before.id, "test");
    expect(deleted.op?.id).toBeTruthy();
    expect(getDb().select().from(F).all()).toHaveLength(0);
    // RateMessage's Undo sends the original verdict, note and reasons, but today's context.
    const restored = rate({ text: "Changed display text", tools: ["other"], model: "different-model" });
    expect(restored.id).toBe(before.id);
    expect(feedbackRow(user, before.id)).toEqual(before);
    expect(getDb().select().from(F).all()).toHaveLength(1);
  });

  it("changing a verdict and replaying the prior one restores review status, triage run and timestamps", () => {
    const before = reviewed();
    expect(rate({ rating: "up", reasons: [], note: "" })).toMatchObject({ status: "new", triagedAt: null });
    rate();
    expect(feedbackRow(user, before.id)).toEqual(before);
  });

  it("can undo deletion explicitly through the returned op exactly once", () => {
    const before = reviewed();
    const deleted = deleteFeedback(user, before.id, "test");
    expect(undoOp(user, deleted.op!.id, "test")).toMatchObject({ outcome: "restored", item: null });
    expect(feedbackRow(user, before.id)).toEqual(before);
    expect(() => undoOp(user, deleted.op!.id, "test")).toThrow(/undone/);
  });

  it("does not replay stale metadata over newer inbox edits", () => {
    const before = reviewed();
    rate({ rating: "up", reasons: [], note: "" });
    patchFeedback(user, before.id, { status: "wont_fix", fixRequested: false }, "test");
    rate();
    expect(feedbackRow(user, before.id)).toMatchObject({ status: "new", triageRunId: null, fixRequestedAt: null });
  });

  it("does not restore another user's snapshot", () => {
    const before = reviewed();
    deleteFeedback(user, before.id, "test");
    getDb().insert(schema.users).values({ id: "other", name: "Other", role: "admin" }).run();
    const other = resolveUser(new Headers(), createSession("other").token)!;
    const created = rateMessage(other, input, "test");
    expect(created.id).not.toBe(before.id);
    expect(created.status).toBe("new");
  });

  it.each([false, true])("Create item Undo restores the previous rating, including when the item was touched: %s", (touch) => {
    const feedback = rate();
    patchFeedback(user, feedback.id, { fixRequested: true }, "test");
    const before = feedbackRow(user, feedback.id);
    const created = createItemFromFeedback(user, feedback.id, "test");
    expect(created.feedback).toMatchObject({ status: "triaged", itemId: created.itemId });
    if (touch) updateItem(user, created.itemId, { summary: "Edited since filing" }, "test");
    expect(undoOp(user, created.op!.id, "test").outcome).toBe(touch ? "archived" : "deleted");
    expect(feedbackRow(user, feedback.id)).toEqual(before);
    expect(getFeedback(user, feedback.id)).toMatchObject({ status: "new", triagedAt: null, itemId: null });
    expect(createItemFromFeedback(user, feedback.id, "test").itemId).not.toBe(created.itemId);
  });

  it("Create item Undo preserves an already reviewed rating's prior state", () => {
    const feedback = rate();
    patchFeedback(user, feedback.id, { status: "wont_fix" }, "test");
    const before = feedbackRow(user, feedback.id);
    const created = createItemFromFeedback(user, feedback.id, "test");
    undoOp(user, created.op!.id, "test");
    expect(feedbackRow(user, feedback.id)).toEqual(before);
  });

  it("refuses create-item Undo atomically if the feedback was edited afterwards", () => {
    const feedback = rate();
    const created = createItemFromFeedback(user, feedback.id, "test");
    patchFeedback(user, feedback.id, { note: "A newer review" }, "test");
    expect(() => undoOp(user, created.op!.id, "test")).toThrow(/changed since/);
    expect(getDb().select().from(schema.workItems).where(eq(schema.workItems.id, created.itemId)).get()?.archived).toBe(false);
    expect(getFeedback(user, feedback.id).note).toBe("A newer review");
  });
});
