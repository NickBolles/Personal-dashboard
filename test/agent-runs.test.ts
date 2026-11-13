/** Work from Jarvis batch 2: agent run-state aggregation, the coordinator "Catch me up" prompt, Undo withdrawing a decision post. */
import { beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { agentRuns } from "@/server/work/agent-runs";
import { coordinatorFor } from "@/server/work/coordinator";
import { listDecisions } from "@/server/work/decisions";
import { aggregateRunState, deployOf, liveOfJob, liveOfRun, whoIsOn, type RunSample } from "@/lib/agent-runs";
import { buildCatchUpPrompt } from "@/lib/catch-up";
import { detectSensitivity } from "@/server/ai/rules";
import { breadcrumbFor } from "@/components/navigation/AppShell";

const cid = "test-wfj2";
const s = (live: RunSample["live"], at: string, sessionId = "s1"): RunSample => ({ live, at, sessionId, source: "chat" });

describe("run-state aggregation (pure)", () => {
  it("maps Hermes run phases and AI job states", () => {
    expect(liveOfRun("waiting_for_approval")).toBe("waiting");
    expect(liveOfRun("running")).toBe("running");
    expect(liveOfRun("queued")).toBe("running");
    expect(liveOfRun("completed")).toBe("finished");
    expect(liveOfRun("interrupted")).toBe("failed");
    expect(liveOfRun("weird")).toBe("idle");
    expect(liveOfJob("waiting_approval")).toBe("waiting");
    expect(liveOfJob("succeeded")).toBe("finished");
    expect(liveOfJob("failed")).toBe("failed");
  });

  it("waiting beats running beats the latest finished/failed run", () => {
    expect(aggregateRunState([]).live).toBe("idle");
    expect(aggregateRunState([s("finished", "2026-11-01T10:00:00Z"), s("failed", "2026-11-01T11:00:00Z")]).live).toBe("failed");
    expect(aggregateRunState([s("failed", "2026-11-01T10:00:00Z"), s("finished", "2026-11-01T11:00:00Z")]).live).toBe("finished");
    const r = aggregateRunState([s("finished", "2026-11-01T12:00:00Z"), s("running", "2026-11-01T09:00:00Z", "s2")]);
    expect(r).toEqual({ live: "running", at: "2026-11-01T09:00:00Z", sessionId: "s2" });
    expect(aggregateRunState([s("running", "2026-11-01T12:00:00Z"), s("waiting", "2026-11-01T08:00:00Z", "s3")]).sessionId).toBe("s3");
  });

  it("who is on it: assignee first, else the area coordinator", () => {
    expect(whoIsOn({ assignee: "agent:devchief" }, "momentumchief")).toEqual({ kind: "agent", name: "devchief" });
    expect(whoIsOn({ assignee: null }, "momentumchief")).toEqual({ kind: "coordinator", name: "momentumchief" });
    expect(whoIsOn({ assignee: null }, "default")).toBeNull();
    expect(whoIsOn({ assignee: "person:u1" }, null, () => "Robin")).toEqual({ kind: "person", name: "Robin" });
  });

  it("deploy state follows the item once a PR is merged", () => {
    expect(deployOf("open", { status: "in_review", decision: null })).toBeNull();
    expect(deployOf("merged", { status: "in_review", decision: null })).toBe("waiting");
    expect(deployOf("merged", { status: "awaiting_validation", decision: null })).toBe("live");
    expect(deployOf("merged", { status: "settled", decision: null })).toBe("live");
    expect(deployOf("merged", { status: "abandoned", decision: null })).toBeNull();
    expect(deployOf("merged", { status: "superseded", decision: null })).toBeNull();
  });
});

describe("catch-me-up prompt (pure)", () => {
  const items = [
    { id: "a", title: "Ship the map", status: "in_progress", decision: null, nextAction: "Open PR", kind: "thread", archived: false },
    { id: "b", title: "Old thing", status: "settled", decision: null, nextAction: "", kind: "thread", archived: false },
    { id: "c", title: "Move savings to the brokerage", status: "ready", decision: null, nextAction: "", kind: "thread", archived: false },
  ] as const;

  it("summarises open items, decisions and activity; done items are left out", () => {
    const p = buildCatchUpPrompt({
      area: { id: "ar", title: "General Dev" },
      items: items.map((i) => ({ ...i })) as never,
      decisions: [{ title: "Ship the map", question: "Phone or desktop first?" }],
      activity: [{ at: "2026-11-02T10:00:00Z", verb: "changed status of", title: "Ship the map", actor: "You" }],
    })!;
    expect(p).toContain('Catch me up on the "General Dev" area.');
    expect(p).toContain("Ship the map [In flight] — next: Open PR");
    expect(p).not.toContain("Old thing");
    expect(p).toContain("Phone or desktop first?");
    expect(p).toContain('2026-11-02 You changed status of "Ship the map"');
  });

  it("includes Finance, excludes AI-excluded areas and credentials", () => {
    expect(buildCatchUpPrompt({ area: { id: "f", title: "Finance" }, items: [], decisions: [], activity: [] })).toContain('"Finance"');
    expect(buildCatchUpPrompt({ area: { id: "f", title: "Money", systemKey: "finance" }, items: [], decisions: [], activity: [] })).toContain('"Money"');
    expect(buildCatchUpPrompt({ area: { id: "x", title: "Home", aiPolicy: "excluded" }, items: [], decisions: [], activity: [] })).toBeNull();
    const p = buildCatchUpPrompt({
      area: { id: "ar", title: "Home" },
      items: items.map((i) => ({ ...i })) as never,
      decisions: [{ title: "Budget", question: "Move money from Monarch?" }],
      activity: [{ at: "2026-11-02T10:00:00Z", verb: "edited", title: "Finance review", actor: "You" }],
    })!;
    expect(p).toMatch(/brokerage/i);
    expect(p).toMatch(/monarch/i);
    expect(p).toMatch(/finance review/i);
    const guarded = buildCatchUpPrompt({
      area: { id: "ar", title: "Home" },
      items: [{ id: "m", title: "password: hunter2hunter2", status: "ready", decision: null, nextAction: null, kind: "thread", archived: false }] as never,
      decisions: [],
      activity: [],
      sensitive: (t) => detectSensitivity(t) === "credentials",
    })!;
    expect(guarded).not.toMatch(/hunter2/i);
  });
});

describe("agent runs + coordinator (server)", () => {
  let owner: string;
  beforeEach(() => {
    __setTestDatabase();
    owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  });
  const userOf = (id: string) => resolveUser(new Headers(), createSession(id).token)!;

  it("aggregates linked runs, PRs and the area coordinator per item (read-only)", async () => {
    const u = userOf(owner);
    const area = store.createItem(u, { kind: "area", title: "General Dev" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "devchief" } }, cid);
    const item = store.createItem(u, { kind: "thread", title: "Agent strip", parentId: area.id }, cid);
    const quiet = store.createItem(u, { kind: "thread", title: "Quiet", parentId: area.id }, cid);
    await store.addLink(u, item.id, { kind: "chat_session", targetId: "sess-1", title: "Chat" }, cid);
    const db = getDb();
    db.insert(schema.runs)
      .values([
        {
          runId: "r1",
          sessionId: "sess-1",
          userId: owner,
          idempotencyKey: "k1",
          status: "completed",
          startedAt: "2026-11-01T10:00:00Z",
          completedAt: "2026-11-01T10:05:00Z",
        },
        { runId: "r2", sessionId: "sess-1", userId: owner, idempotencyKey: "k2", status: "waiting_for_approval", startedAt: "2026-11-02T10:00:00Z" },
      ])
      .run();
    db.insert(schema.workLinks)
      .values({
        id: "l1",
        itemId: item.id,
        kind: "github_pr",
        targetId: "o/r#7",
        url: "https://github.com/o/r/pull/7",
        title: "PR 7",
        externalState: "merged",
        checksState: "success",
      })
      .run();
    const r = agentRuns(u);
    const info = r.items[item.id]!;
    expect(info.who).toEqual({ kind: "coordinator", name: "devchief" });
    expect(info.live).toBe("waiting");
    expect(info.sessionId).toBe("sess-1");
    expect(info.prs).toEqual([{ ref: "o/r#7", url: "https://github.com/o/r/pull/7", title: "PR 7", state: "merged", checks: "success", deploy: "waiting" }]);
    expect(r.items[quiet.id]!.live).toBe("idle");
    expect(r.active.map((a) => a.itemId)).toEqual([item.id]);
    // nothing written
    expect(db.select().from(schema.runs).all()).toHaveLength(2);
  });

  it("coordinator info: Finance gets a prompt unless AI-excluded; decisions offer the coordinator chat", async () => {
    const u = userOf(owner);
    const fin = store.createItem(u, { kind: "area", title: "Finance" }, cid);
    store.createItem(u, { kind: "thread", title: "Rebalance", parentId: fin.id }, cid);
    const fc = coordinatorFor(u, fin.id);
    expect(fc.excluded).toBe(false);
    expect(fc.prompt).toContain("Rebalance");
    store.updateItem(u, fin.id, { settings: { aiPolicy: "excluded" } }, cid);
    expect(coordinatorFor(u, fin.id).prompt).toBeNull();
    const dev = store.createItem(u, { kind: "area", title: "General Dev" }, cid);
    const t = store.createItem(u, { kind: "thread", title: "Coordinator pane", parentId: dev.id }, cid);
    store.updateItem(u, t.id, { decision: { question: "Sheet or dialog?", choices: ["Sheet", "Dialog"] } }, cid);
    const dc = coordinatorFor(u, dev.id);
    expect(dc.excluded).toBe(false);
    expect(dc.sessionId).toBeNull();
    expect(dc.prompt).toContain("Coordinator pane");
    expect(dc.prompt).toContain("Sheet or dialog?");
    expect(dc.prompt).not.toContain("Rebalance");
    // A conversation filed directly under the area becomes its coordinator chat.
    db_conv(owner, dev.id, "sess-coord");
    expect(coordinatorFor(u, dev.id).sessionId).toBe("sess-coord");
    const entry = listDecisions(u).entries.find((e) => e.itemId === t.id)!;
    expect(entry.sessionId).toBeNull();
    expect(entry.coordinatorSessionId).toBe("sess-coord");
  });

  it("#169: an existing coordinator conversation is labelled with the profile it runs on, not the area's current mode", () => {
    const u = userOf(owner);
    const area = store.createItem(u, { kind: "area", title: "Ops Desk" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "devchief" } }, cid);
    // no conversation yet: the area's mode decides (routing is off → not routed)
    expect(coordinatorFor(u, area.id).agent).toMatchObject({ requested: "devchief", profile: null, routed: false });
    db_conv(owner, area.id, "sess-ops");
    getDb().insert(schema.sessionMeta).values({ sessionId: "sess-ops", userId: owner, hermesProfile: "momentumchief" }).run();
    expect(coordinatorFor(u, area.id).agent).toMatchObject({ profile: "momentumchief", routed: true });
  });
});

function db_conv(userId: string, parentId: string, sessionId: string) {
  getDb()
    .insert(schema.workItems)
    .values({ id: `wk_${sessionId}`, userId, parentId, kind: "conversation", title: "Coordinator", sessionId, status: "in_progress" })
    .run();
}

describe("decisions + navigation fixes", () => {
  it("/decisions has its own top-bar title (not Areas)", () => {
    expect(breadcrumbFor("/decisions")[0]!.label).toBe("Needs you");
    expect(breadcrumbFor("/areas")[0]!.label).toBe("Areas");
  });
});
