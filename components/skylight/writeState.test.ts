import { describe, expect, it } from "vitest";
import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { applyOverlay, optimisticChecked, optimisticStatus, settledKeys, UNDO_WINDOW_MS, writeReducer, type WriteEvent, type WriteState } from "./writeState";

const complete: SkylightWriteOp = { op: "chore.complete", title: "Lantern", choreId: "c1", categoryId: null };
const skip: SkylightWriteOp = { op: "chore.skip", title: "Lantern", choreId: "c1", categoryId: null };
const claim: SkylightWriteOp = { op: "chore.claim", title: "Lantern", choreId: "c1", fromCategoryId: null };
const reopen: SkylightWriteOp = { op: "chore.reopen", title: "Lantern", choreId: "c1", categoryId: null };

const action = (over: Partial<NextAction> = {}): NextAction =>
  ({
    id: "sky:c1",
    source: "skylight",
    sourceId: "c1",
    title: "Lantern",
    status: "open",
    priorityReason: "today",
    updatedAt: "2026-11-07T10:00:00.000Z",
    fetchedAt: "2026-11-07T10:00:00.000Z",
    staleAfter: "2026-11-07T11:00:00.000Z",
    href: "https://app.ourskylight.com/",
    skylight: { kind: "chore", choreId: "c1", categoryId: null, startDate: "2026-11-07" },
    ...over,
  }) as NextAction;

const run = (events: WriteEvent[], start: WriteState = {}) => events.reduce(writeReducer, start);
const K = "sky:c1";

describe("optimistic Skylight write state machine", () => {
  it("confirm → pending (tick drawn, still in its list) → leaving → done (completed)", () => {
    let s = run([{ type: "confirm", key: K, op: complete, at: 1 }]);
    expect(s[K]!.phase).toBe("pending");
    expect(optimisticChecked(action(), s[K])).toBe(true);
    expect(optimisticStatus(action(), s[K])).toBe("open");
    s = run([{ type: "success", key: K, writeId: "w1", at: 2 }], s);
    expect(s[K]).toMatchObject({ phase: "leaving", writeId: "w1" });
    expect(optimisticStatus(action(), s[K])).toBe("open");
    s = run([{ type: "settle", key: K, at: 3 }], s);
    expect(s[K]!.phase).toBe("done");
    expect(optimisticStatus(action(), s[K])).toBe("completed");
    const [row] = applyOverlay([action()], s, "2026-11-07");
    expect(row).toMatchObject({ status: "completed", skylight: { completedOn: "2026-11-07" } });
  });

  it("a double tap while pending is ignored (one write per row)", () => {
    const s = run([
      { type: "confirm", key: K, op: complete, at: 1 },
      { type: "confirm", key: K, op: skip, at: 2 },
    ]);
    expect(s[K]).toMatchObject({ phase: "pending", op: complete, at: 1 });
  });

  it("error → failed (shake) → settle clears it: the row is back exactly as it was", () => {
    let s = run([
      { type: "confirm", key: K, op: complete, at: 1 },
      { type: "error", key: K, at: 2 },
    ]);
    expect(s[K]!.phase).toBe("failed");
    expect(optimisticChecked(action(), s[K])).toBe(false);
    expect(optimisticStatus(action(), s[K])).toBe("open");
    s = run([{ type: "settle", key: K, at: 3 }], s);
    expect(s[K]).toBeUndefined();
    expect(applyOverlay([action()], s, "2026-11-07")[0]).toEqual(action());
  });

  it("undo → undoing → restored puts the row back open; an undo error keeps it done", () => {
    const done = run([
      { type: "confirm", key: K, op: complete, at: 1 },
      { type: "success", key: K, at: 2 },
      { type: "settle", key: K, at: 3 },
    ]);
    const undoing = run([{ type: "undo", key: K, at: 4 }], done);
    expect(undoing[K]!.phase).toBe("undoing");
    expect(optimisticStatus(action(), undoing[K])).toBe("completed");
    const restored = run([{ type: "undone", key: K, at: 5 }], undoing);
    expect(restored[K]!.phase).toBe("restored");
    expect(optimisticStatus(action(), restored[K])).toBe("open");
    expect(optimisticChecked(action(), restored[K])).toBe(false);
    const failed = run([{ type: "undo-error", key: K, at: 5 }], undoing);
    expect(failed[K]!.phase).toBe("done");
  });

  it("undo is also possible while the row is still leaving", () => {
    const s = run([
      { type: "confirm", key: K, op: complete, at: 1 },
      { type: "success", key: K, at: 2 },
      { type: "undo", key: K, at: 3 },
    ]);
    expect(s[K]!.phase).toBe("undoing");
  });

  it("skip hides the row once landed; claim never moves it (pending → done, no collapse)", () => {
    const skipped = run([
      { type: "confirm", key: K, op: skip, at: 1 },
      { type: "success", key: K, at: 2 },
      { type: "settle", key: K, at: 3 },
    ]);
    expect(applyOverlay([action()], skipped, "2026-11-07")).toEqual([]);
    const claimed = run([
      { type: "confirm", key: K, op: claim, at: 1 },
      { type: "success", key: K, at: 2 },
    ]);
    expect(claimed[K]!.phase).toBe("done");
    expect(applyOverlay([action()], claimed, "2026-11-07")[0]).toEqual(action());
  });

  it("reopen moves a completed chore back to open", () => {
    const s = run([
      { type: "confirm", key: K, op: reopen, at: 1 },
      { type: "success", key: K, at: 2 },
      { type: "settle", key: K, at: 3 },
    ]);
    const [row] = applyOverlay([action({ status: "completed" })], s, "2026-11-07");
    expect(row!.status).toBe("open");
  });

  it("never clears an entry mid-request; settles once the server agrees and the undo window is over", () => {
    const pending = run([{ type: "confirm", key: K, op: complete, at: 1 }]);
    expect(run([{ type: "clear", key: K }], pending)).toBe(pending);
    const done = run(
      [
        { type: "success", key: K, at: 1_000 },
        { type: "settle", key: K, at: 1_000 },
      ],
      pending,
    );
    const server = [action({ status: "completed" })];
    expect(settledKeys(server, done, 1_000 + 100)).toEqual([]); // Undo still possible
    expect(settledKeys([action()], done, 1_000 + UNDO_WINDOW_MS + 1)).toEqual([]); // server not caught up
    expect(settledKeys(server, done, 1_000 + UNDO_WINDOW_MS + 1)).toEqual([K]);
    expect(settledKeys([action()], done, 1_000 + 61_000)).toEqual([K]); // stale overlay never sticks
    const restored = run(
      [
        { type: "undo", key: K, at: 2_000 },
        { type: "undone", key: K, at: 2_100 },
      ],
      done,
    );
    expect(settledKeys(server, restored, 2_200)).toEqual([]);
    expect(settledKeys([action()], restored, 2_200)).toEqual([K]);
  });
});
