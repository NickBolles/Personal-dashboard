/** CW-2/CW-4 runs, structured notices and owner read markers against the migrated SQLite schema. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, userById, type CurrentUser } from "@/server/auth";
import { __resetAgentRate, mintAgentToken } from "@/server/agent-access/tokens";
import { createItem, listItems, placeConversation } from "@/server/work/store";
import { agentRuns, executionRuns } from "@/server/work/agent-runs";
import { registerAgentRun, finishRegisteredRun } from "@/server/work/registered-runs";
import { syncDelegatedRuns } from "@/server/work/delegated-runs";
import { ensureRunSeqs, lastLooked, listRunEvents, markLooked, recordRunEvent, resolveRun, runTree } from "@/server/work/run-events";
import { AGENT_RUN_LABEL, AGENT_RUN_STATES, liveOfAgentRun } from "@/lib/agent-runs";
import { SYSTEM_RUN_EVENTS, type Pipeline } from "@/lib/cw-runs";
import * as mcpRoute from "@/app/api/mcp/route";
import * as runsRoute from "@/app/api/coordinator/runs/route";
import * as eventsRoute from "@/app/api/coordinator/runs/[ref]/events/route";
import * as lookedRoute from "@/app/api/coordinator/looked/route";

const cid = "cw-runs-test";
const pipeline: Pipeline = [{ stage: "ci", state: "ok", label: "Checks passed" }];
let owner: CurrentUser;
let token: string;
let itemId: string;
let session: string;
let n = 0;
type ToolResult = { runId: string; ref: string; eventId: string; runRef: string; state: string; existing?: boolean; error?: string };

async function call(name: string, args: Record<string, unknown>, credential = token) {
  const res = await mcpRoute.POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  expect(res.status).toBe(200);
  const json = await res.json();
  return { isError: !!json.result.isError, value: JSON.parse(json.result.content[0].text) as ToolResult };
}
async function start(extra: Record<string, unknown> = {}) {
  const result = await call("jarvis_run_start", { itemId, title: "Build the slice", ...extra });
  expect(result.isError).toBe(false);
  return result.value;
}
const row = (id: string) => getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get()!;
const ctx = (): { params: Promise<Record<string, string>> } => ({ params: Promise.resolve({}) });
const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = { cookie: `jarvis_session=${session}` }) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "x-jarvis-csrf": "1", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
function otherOwner() {
  getDb().insert(schema.users).values({ id: "other", name: "Other owner", role: "admin" }).run();
  return userById("other")!;
}

beforeEach(() => {
  __setTestDatabase();
  __resetAgentRate();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  session = createSession(id).token;
  owner = resolveUser(new Headers(), session)!;
  token = mintAgentToken(owner, { name: "Worker", profile: "devchief", scopes: ["work.read", "runs.write"] }, cid).token;
  const area = createItem(owner, { kind: "area", title: "Workshop" }, cid);
  itemId = createItem(owner, { kind: "thread", title: "CW runs", parentId: area.id }, cid).id;
});
afterEach(() => vi.useRealTimers());

describe("CW references and lifecycle", () => {
  it("assigns monotonically increasing per-owner refs, never reusing a pruned highest run", async () => {
    const one = await start({ delegationId: "one" });
    const again = await start({ delegationId: "one" });
    expect(one.ref).toBe("R-1");
    expect(again).toMatchObject({ runId: one.runId, ref: "R-1", existing: true });
    expect(listRunEvents(owner.id).map((e) => e.type)).toEqual(["started"]);
    const two = await start();
    expect(two.ref).toBe("R-2");
    getDb().delete(schema.agentRuns).where(eq(schema.agentRuns.id, two.runId)).run();
    expect((await start()).ref).toBe("R-3");
    const other = otherOwner();
    const area = createItem(other, { kind: "area", title: "Other workshop" }, cid);
    expect(registerAgentRun(other, "devchief", { itemId: area.id, title: "Other run" }, cid).ref).toBe("R-1");
    expect(listRunEvents(other.id)).toHaveLength(1);
  });

  it("repairs null seqs in all owner list functions, preserving assigned refs", async () => {
    const first = await start();
    const insert = (id: string) =>
      getDb().insert(schema.agentRuns).values({ id, userId: owner.id, itemId, profile: "devchief", title: id, hermesSessionId: "cw-chat" }).run();
    insert("legacy_a");
    agentRuns(owner);
    expect(row("legacy_a").seq).toBe(2);
    insert("legacy_b");
    executionRuns(owner, "cw-chat");
    expect(row("legacy_b").seq).toBe(3);
    insert("legacy_c");
    listRunEvents(owner.id);
    expect(row("legacy_c").seq).toBe(4);
    insert("legacy_d");
    runTree(owner);
    expect(row("legacy_d").seq).toBe(5);
    ensureRunSeqs(owner.id);
    expect(row(first.runId).seq).toBe(1);
  });

  it("uses the same sequence allocator for automatic delegated mirrors", async () => {
    await start();
    placeConversation(owner, { sessionId: "cw-parent", parentId: itemId, title: "Coordinator" }, cid);
    expect(
      syncDelegatedRuns(owner, "cw-parent", "devchief", [
        { key: "subagent:child", source: "subagent", id: "child", title: "Child", state: "running", delegationId: "cw-batch" },
      ]),
    ).toBe(1);
    const mirror = getDb()
      .select()
      .from(schema.agentRuns)
      .all()
      .find((r) => r.delegationId?.startsWith("sub:"))!;
    expect(mirror.seq).toBe(2);
    expect(listRunEvents(owner.id, { runIds: [mirror.id] })[0]).toMatchObject({ type: "started", runRef: "R-2" });
  });

  it("accepts parents by ref and id, but refuses another owner's id or an unavailable parent", async () => {
    const parent = await start();
    const child = await start({ parentRunId: parent.ref });
    const grandchild = await start({ parentRunId: child.runId });
    expect(row(child.runId).parentRunId).toBe(parent.runId);
    expect(row(grandchild.runId).parentRunId).toBe(child.runId);
    const other = otherOwner();
    const area = createItem(other, { kind: "area", title: "Other area" }, cid);
    const foreign = registerAgentRun(other, "devchief", { itemId: area.id, title: "Foreign" }, cid);
    expect((await call("jarvis_run_start", { itemId, title: "Bad", parentRunId: foreign.runId })).value.error).toBe("not_found");
    expect(() => registerAgentRun(owner, "devchief", { itemId, title: "Bad", parentRunId: foreign.runId }, cid)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    getDb().update(schema.workItems).set({ archived: true }).where(eq(schema.workItems.id, itemId)).run();
    const visibleItem = createItem(
      owner,
      { kind: "thread", title: "Visible", parentId: listItems(owner.id).find((i) => i.kind === "area" && i.title === "Workshop")!.id },
      cid,
    );
    expect((await call("jarvis_run_start", { itemId: visibleItem.id, title: "Bad", parentRunId: parent.ref })).value.error).toBe("not_found");
  });

  it("records interrupted/resumed and terminal transitions once, clears interruptedAt, and is not terminal on interruption", async () => {
    const run = await start();
    expect(AGENT_RUN_STATES).toEqual(["running", "waiting", "done", "failed", "interrupted"]);
    expect(AGENT_RUN_LABEL.interrupted).toBe("Interrupted");
    expect(liveOfAgentRun("interrupted")).toBe("waiting");
    for (const state of ["interrupted", "interrupted"]) {
      expect((await call("jarvis_run_update", { runId: run.ref, state })).value).toMatchObject({ runId: run.runId, ref: run.ref, state });
    }
    expect(row(run.runId).interruptedAt).toBeTruthy();
    expect(row(run.runId).finishedAt).toBeNull();
    await call("jarvis_run_update", { runId: run.ref, state: "interrupted", hermesSessionId: "cw-interrupted" });
    expect(executionRuns(owner, "cw-interrupted").registered[0]).toMatchObject({ state: "waiting", endedAt: null });
    await call("jarvis_run_update", { runId: run.runId, state: "running" });
    await call("jarvis_run_update", { runId: run.ref, state: "running" });
    expect(row(run.runId).interruptedAt).toBeNull();
    expect(listRunEvents(owner.id).map((e) => e.type)).toEqual(["started", "interrupted", "resumed"]);
    for (const state of ["done", "done", "failed", "failed"]) await call("jarvis_run_update", { runId: run.ref, state, summary: "x".repeat(400) });
    expect(row(run.runId).finishedAt).toBeTruthy();
    expect(listRunEvents(owner.id).map((e) => e.type)).toEqual(["started", "interrupted", "resumed", "done", "failed"]);
    expect(listRunEvents(owner.id).at(-1)!.summary).toHaveLength(300);
  });

  it.each(["waiting", "done", "failed"] as const)("clears interruptedAt on %s; server-owned transitions agree", async (state) => {
    const run = await start();
    finishRegisteredRun(owner, run.runId, "interrupted", "Paused", new Date());
    await call("jarvis_run_update", { runId: run.ref, state });
    expect(row(run.runId).interruptedAt).toBeNull();
    expect(row(run.runId).finishedAt === null).toBe(state === "waiting");
    finishRegisteredRun(owner, run.runId, "running", "Resuming", new Date());
    finishRegisteredRun(owner, run.runId, "running", "Heartbeat", new Date());
    expect(listRunEvents(owner.id).filter((e) => e.type === "resumed")).toHaveLength(1);
  });

  it("run_update accepts validated pipeline and nullable lock without extra lifecycle events", async () => {
    const run = await start();
    expect((await call("jarvis_run_update", { runId: run.ref, state: "running", pipeline, lock: { name: "build" } })).isError).toBe(false);
    expect(JSON.parse(row(run.runId).pipelineJson!)).toEqual(pipeline);
    expect(JSON.parse(row(run.runId).lockJson!)).toEqual({ name: "build" });
    await call("jarvis_run_update", { runId: run.ref, state: "running", lock: null });
    expect(row(run.runId).lockJson).toBeNull();
    expect((await call("jarvis_run_update", { runId: run.ref, state: "running", pipeline: [{ stage: "bogus", state: "ok" }] })).value.error).toBe("validation");
    expect(listRunEvents(owner.id).map((e) => e.type)).toEqual(["started"]);
  });
});

describe("CW structured run events", () => {
  it("folds notices into the run card, writes no work/chat activity, and refreshes the heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T18:00:00Z"));
    const run = await start();
    const workBefore = getDb().select().from(schema.workEvents).all();
    const chatBefore = getDb().select().from(schema.aiMessages).all();
    vi.setSystemTime(new Date("2026-11-08T18:45:00Z"));
    expect(runTree(owner).runs[0]!.stalled).toBe(true);
    const result = await call("jarvis_run_event", {
      runId: run.ref,
      type: "notice",
      summary: "Background check finished; no owner action",
      payload: { child: "check" },
    });
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({ runRef: "R-1" });
    expect(row(run.runId).updatedAt).toBe("2026-11-08T18:45:00.000Z");
    expect(getDb().select().from(schema.workEvents).all()).toEqual(workBefore);
    expect(getDb().select().from(schema.aiMessages).all()).toEqual(chatBefore);
    expect(runTree(owner).runs[0]).toMatchObject({
      stalled: false,
      noticeCount: 1,
      lastEvent: { id: result.value.eventId, type: "notice", payload: { child: "check" }, via: "agent:devchief" },
    });
  });

  it("refuses system types, other profiles/owners, excluded and archived items, and missing scope", async () => {
    const run = await start();
    for (const type of SYSTEM_RUN_EVENTS) expect((await call("jarvis_run_event", { runId: run.ref, type, summary: "Fake" })).isError).toBe(true);
    const other = mintAgentToken(owner, { name: "Other profile", profile: "homelabchief", scopes: ["runs.write"] }, cid).token;
    for (const name of ["jarvis_run_event", "jarvis_run_update"]) {
      const args = name === "jarvis_run_event" ? { type: "notice", summary: "No" } : { state: "interrupted" };
      expect((await call(name, { runId: run.ref, ...args }, other)).value.error).toBe("not_found");
    }
    const ro = mintAgentToken(owner, { name: "Read only", profile: "devchief", scopes: ["work.read"] }, cid).token;
    expect((await call("jarvis_run_event", { runId: run.ref, type: "notice", summary: "No" }, ro)).value.error).toBe("forbidden");
    const foreign = otherOwner();
    const foreignArea = createItem(foreign, { kind: "area", title: "Foreign area" }, cid);
    const foreignRun = registerAgentRun(foreign, "devchief", { itemId: foreignArea.id, title: "Foreign run" }, cid);
    expect((await call("jarvis_run_event", { runId: foreignRun.runId, type: "notice", summary: "No" })).value.error).toBe("not_found");
    const areaId = listItems(owner.id).find((i) => i.id === itemId)!.parentId!;
    getDb()
      .update(schema.workItems)
      .set({ settings: JSON.stringify({ aiPolicy: "excluded" }) })
      .where(eq(schema.workItems.id, areaId))
      .run();
    expect((await call("jarvis_run_event", { runId: run.ref, type: "notice", summary: "No" })).value.error).toBe("not_found");
    getDb().update(schema.workItems).set({ settings: null, archived: true }).where(eq(schema.workItems.id, areaId)).run();
    expect((await call("jarvis_run_event", { runId: run.ref, type: "notice", summary: "No" })).value.error).toBe("not_found");
    expect(listRunEvents(owner.id)).toHaveLength(1);
  });

  it("enforces summary and serialized UTF-8 payload caps, including exact boundary and server insert path", async () => {
    const run = await start();
    const base = { runId: run.ref, type: "notice", summary: "Notice" };
    expect((await call("jarvis_run_event", { ...base, summary: "x".repeat(301) })).value.error).toBe("validation");
    // {"x":""} is 8 bytes; exactly 4096 bytes is accepted, 4097 is not.
    expect((await call("jarvis_run_event", { ...base, payload: { x: "x".repeat(4088) } })).isError).toBe(false);
    expect((await call("jarvis_run_event", { ...base, payload: { x: "x".repeat(4089) } })).value.error).toBe("payload_too_large");
    expect((await call("jarvis_run_event", { ...base, payload: { x: "é".repeat(2045) } })).value.error).toBe("payload_too_large");
    expect(() => recordRunEvent(getDb(), { userId: owner.id, runId: run.runId, type: "notice", summary: "Bad", payload: { x: "x".repeat(4096) } })).toThrow(
      expect.objectContaining({ status: 400, code: "payload_too_large" }),
    );
    expect(listRunEvents(owner.id)).toHaveLength(2);
  });

  it("sets/clears locks and updates CI/release pipeline; invalid data rolls back event and heartbeat", async () => {
    const run = await start();
    const lock = { name: "deploy", holder: "worker", mode: "holds", since: "2026-11-08T18:00:00Z" };
    expect((await call("jarvis_run_event", { runId: run.ref, type: "lock.acquired", summary: "Acquired", payload: { lock } })).isError).toBe(false);
    expect(JSON.parse(row(run.runId).lockJson!)).toEqual(lock);
    await call("jarvis_run_event", { runId: run.ref, type: "lock.released", summary: "Released" });
    expect(row(run.runId).lockJson).toBeNull();
    for (const type of ["ci", "release.staged", "release.live"]) {
      expect((await call("jarvis_run_event", { runId: run.ref, type, summary: "Updated", payload: { pipeline } })).isError).toBe(false);
      expect(JSON.parse(row(run.runId).pipelineJson!)).toEqual(pipeline);
    }
    const before = listRunEvents(owner.id);
    const heartbeat = row(run.runId).updatedAt;
    for (const payload of [{ pipeline: [{ stage: "no", state: "ok" }] }, { pipeline: null }])
      expect((await call("jarvis_run_event", { runId: run.ref, type: "ci", summary: "Invalid", payload })).value.error).toBe("validation");
    expect((await call("jarvis_run_event", { runId: run.ref, type: "lock.acquired", summary: "Invalid", payload: { lock: { name: "" } } })).value.error).toBe(
      "validation",
    );
    expect(listRunEvents(owner.id)).toEqual(before);
    expect(row(run.runId).updatedAt).toBe(heartbeat);
  });

  it("lists latest events chronologically with owner/run/since isolation, bounded limit and stable same-time ordering", async () => {
    const run = await start();
    for (let i = 0; i < 205; i++) recordRunEvent(getDb(), { userId: owner.id, runId: run.runId, type: "progress", summary: String(i) });
    const latest = listRunEvents(owner.id, { runIds: [run.runId], limit: 200 });
    expect(latest).toHaveLength(200);
    expect(latest[0]!.summary).toBe("5");
    expect(latest.at(-1)!.summary).toBe("204");
    expect(listRunEvents(owner.id, { runIds: [] })).toEqual([]);
    expect(listRunEvents(owner.id, { runIds: ["missing"] })).toEqual([]);
    expect(listRunEvents(owner.id, { since: "2099-01-01T00:00:00Z" })).toEqual([]);
    expect(() => listRunEvents(owner.id, { limit: 201 })).toThrow();
    expect(() => recordRunEvent(getDb(), { userId: otherOwner().id, runId: run.runId, type: "progress", summary: "No" })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe("CW owner read model and routes", () => {
  it("sorts attention states first (newest within group), then running/done, maps tree metadata and hides inaccessible/archived branches", async () => {
    const runs = [];
    for (const state of ["done", "running", "interrupted", "waiting", "failed"] as const) {
      const run = await start();
      await call("jarvis_run_update", { runId: run.ref, state });
      getDb()
        .update(schema.agentRuns)
        .set({ updatedAt: `2026-11-08T18:0${runs.length}:00.000Z` })
        .where(eq(schema.agentRuns.id, run.runId))
        .run();
      runs.push(run);
    }
    const mapped = runTree(owner).runs;
    expect(mapped.map((r) => r.state)).toEqual(["failed", "waiting", "interrupted", "running", "done"]);
    const child = await start({ parentRunId: runs[1]!.ref });
    expect(runTree(owner).runs.find((r) => r.id === child.runId)).toMatchObject({
      ref: child.ref,
      itemTitle: "CW runs",
      parentRunId: runs[1]!.runId,
      parentRef: runs[1]!.ref,
      pipeline: [],
      lock: null,
      noticeCount: 0,
    });
    expect(runTree(owner, []).runs).toEqual([]);
    const other = otherOwner();
    expect(runTree(other, listItems(owner.id)).runs).toEqual([]);
    expect(
      (
        await eventsRoute.GET(
          req("/api/coordinator/runs/foreign/events", "GET", undefined, {
            cookie: `jarvis_session=${createSession(other.id).token}`,
          }),
          { params: Promise.resolve({ ref: child.runId }) },
        )
      ).status,
    ).toBe(404);
    const areaId = listItems(owner.id).find((i) => i.id === itemId)!.parentId!;
    getDb().update(schema.workItems).set({ archived: true }).where(eq(schema.workItems.id, areaId)).run();
    expect(runTree(owner).runs).toEqual([]);
    const hidden = await runsRoute.GET(req("/api/coordinator/runs"), ctx());
    expect(await hidden.json()).toMatchObject({ runs: [], events: [] });
    expect((await eventsRoute.GET(req(`/api/coordinator/runs/${child.ref}/events`), { params: Promise.resolve({ ref: child.ref }) })).status).toBe(404);
  });

  it("caps tree at 200 after priority sorting, not before", () => {
    const db = getDb();
    db.transaction((tx) => {
      for (let i = 1; i <= 205; i++)
        tx.insert(schema.agentRuns)
          .values({ id: `raw_${i}`, userId: owner.id, itemId, profile: "devchief", title: "Run", seq: i, state: "done" })
          .run();
    });
    const failed = registerAgentRun(owner, "devchief", { itemId, title: "Old failure" }, cid);
    finishRegisteredRun(owner, failed.runId, "failed", "Needs attention", new Date("2020-01-01T00:00:00Z"));
    const tree = runTree(owner);
    expect(tree.runs).toHaveLength(200);
    expect(tree.runs[0]!.id).toBe(failed.runId);
  });

  it("upserts independent owner/surface markers, normalizes offsets and clamps future timestamps", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T18:00:00Z"));
    expect(lastLooked(owner.id)).toEqual({ chat: null, needs: null, running: null, changes: null, context: null });
    markLooked(owner.id, "running", "2026-11-08T08:00:00-08:00");
    expect(lastLooked(owner.id).running).toBe("2026-11-08T16:00:00.000Z");
    markLooked(owner.id, "running", "2099-01-01T00:00:00Z");
    markLooked(owner.id, "chat");
    expect(lastLooked(owner.id)).toMatchObject({ running: "2026-11-08T18:00:00.000Z", chat: "2026-11-08T18:00:00.000Z", needs: null });
    expect(getDb().select().from(schema.ownerMarkers).all()).toHaveLength(2);
    expect(lastLooked(otherOwner().id).running).toBeNull();
    expect(() => markLooked(owner.id, "running", "bad-date")).toThrow();
  });

  it("requires owner auth and work.use on every handler, rejecting agent bearer tokens", async () => {
    const run = await start();
    const handlers = [
      (headers: Record<string, string>) => runsRoute.GET(req("/api/coordinator/runs", "GET", undefined, headers), ctx()),
      (headers: Record<string, string>) =>
        eventsRoute.GET(req("/api/coordinator/runs/R-1/events", "GET", undefined, headers), { params: Promise.resolve({ ref: run.ref }) }),
      (headers: Record<string, string>) => lookedRoute.GET(req("/api/coordinator/looked", "GET", undefined, headers), ctx()),
      (headers: Record<string, string>) => lookedRoute.POST(req("/api/coordinator/looked", "POST", { surface: "running" }, headers), ctx()),
    ];
    getDb().insert(schema.users).values({ id: "kid", name: "Kid", role: "kid" }).run();
    const kid = createSession("kid").token;
    for (const handler of handlers) {
      expect((await handler({})).status).toBe(401);
      expect((await handler({ authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await handler({ cookie: `jarvis_session=${kid}` })).status).toBe(403);
      expect((await handler({ cookie: `jarvis_session=${session}` })).status).toBe(200);
    }
  });

  it("returns owner data, bounded per-run events and lastLooked; rejects malformed refs, limits, bodies and CSRF", async () => {
    const run = await start();
    const notice = await call("jarvis_run_event", { runId: run.ref, type: "notice", summary: "Complete" });
    const post = await lookedRoute.POST(req("/api/coordinator/looked", "POST", { surface: "running", at: "2099-01-01T00:00:00Z" }), ctx());
    expect(post.status).toBe(200);
    const marks = (await post.json()).lastLooked;
    expect(Date.parse(marks.running)).toBeLessThanOrEqual(Date.now());
    const response = await runsRoute.GET(req("/api/coordinator/runs"), ctx());
    const result = await response.json();
    expect(result.runs[0]).toMatchObject({ id: run.runId, ref: run.ref, noticeCount: 1 });
    expect(result.events.map((e: { type: string }) => e.type)).toEqual(["started", "notice"]);
    expect(result.lastLooked).toEqual(marks);
    for (const ref of [run.ref, run.runId]) {
      const events = await eventsRoute.GET(req(`/api/coordinator/runs/${ref}/events?limit=1`), { params: Promise.resolve({ ref }) });
      expect(events.status).toBe(200);
      expect((await events.json()).events).toHaveLength(1);
      expect(
        (await (await eventsRoute.GET(req(`/api/coordinator/runs/${ref}/events?limit=1`), { params: Promise.resolve({ ref }) })).json()).events[0].id,
      ).toBe(notice.value.eventId);
    }
    for (const ref of ["R-0", "R-01", " R-1", "R-1 ", "R-1000000000", "R-999", "../bad", "bad.id"]) {
      expect((await eventsRoute.GET(req("/api/coordinator/runs/bad/events"), { params: Promise.resolve({ ref }) })).status).toBe(404);
      expect(() => resolveRun(owner.id, ref)).toThrow();
    }
    for (const limit of ["0", "201", "-1", "1.5", "abc", ""])
      expect((await eventsRoute.GET(req(`/api/coordinator/runs/R-1/events?limit=${limit}`), { params: Promise.resolve({ ref: run.ref }) })).status).toBe(400);
    for (const body of [{ surface: "bogus" }, { surface: "running", at: "bad" }, { surface: "running", extra: true }])
      expect((await lookedRoute.POST(req("/api/coordinator/looked", "POST", body), ctx())).status).toBe(400);
    const noCsrf = new NextRequest("http://localhost/api/coordinator/looked", {
      method: "POST",
      headers: { cookie: `jarvis_session=${session}` },
      body: JSON.stringify({ surface: "running" }),
    });
    expect((await lookedRoute.POST(noCsrf, ctx())).status).toBe(403);
  });
});
