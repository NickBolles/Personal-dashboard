import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { createItem, placeConversation } from "@/server/work/store";
import { enqueue } from "@/server/ai/jobs";
import { saveAiSettings } from "@/server/ai/settings";

let user: CurrentUser;
let area: string;
beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  user = resolveUser(new Headers(), createSession(id).token)!;
  saveAiSettings({ enabled: true });
  area = createItem(user, { kind: "area", title: "General Dev" }, "test").id;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network for enqueue guard");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const start = (id: string) =>
  enqueue({ userId: user.id, kind: "summarize", subjectType: "work_item", subjectId: id, clientKey: "summary-guard", correlationId: "test" });

describe("summary destination guard before enqueue", () => {
  it.each(["note", "conversation"] as const)("rejects %s before recording any job or paid work", (kind) => {
    const item =
      kind === "note"
        ? createItem(user, { parentId: area, kind, title: "Findings" }, "test")
        : placeConversation(user, { parentId: area, sessionId: "loc_summary", title: "Discussion" }, "test");
    expect(() => start(item.id)).toThrow(expect.objectContaining({ status: 409, code: "summary_no_destination" }));
    expect(getDb().select().from(schema.aiJobs).all()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still queues a summary for an item that can hold a note", () => {
    const item = createItem(user, { parentId: area, kind: "thread", title: "Work item" }, "test");
    expect(start(item.id)).toMatchObject({ created: true, job: { kind: "summarize", state: "queued" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
