/** Work from Jarvis batch 1: map rollups, decisions aggregation, answer logging + undo. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as store from "@/server/work/store";
import { listDecisions, mapData, mapExport } from "@/server/work/decisions";
import { listActivity } from "@/server/work/activity";
import { appendDecisionToSummary, decisionInputSchema, parseDecision, serialiseDecision, sortDecisions, type DecisionEntry } from "@/lib/decisions";
import { areaRollups, bucketOf, matchesFilter } from "@/lib/map-rollup";
import type { WorkItem } from "@/lib/work";

const base: WorkItem = {
  id: "x",
  parentId: null,
  kind: "thread",
  title: "T",
  summary: "",
  nextAction: "",
  status: "captured",
  sortOrder: 0,
  startDate: null,
  targetDate: null,
  completedAt: null,
  settledKind: null,
  settledReason: null,
  archived: false,
  builtIn: false,
  validationDefault: null,
  sessionId: null,
  settings: null,
  tags: [],
  assignee: null,
  decision: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const it_ = (o: Partial<WorkItem>): WorkItem => ({ ...base, ...o });

describe("map rollups (pure)", () => {
  it("maps statuses to the portfolio buckets; an open decision wins unless done", () => {
    expect(bucketOf(it_({ status: "in_progress" }))).toBe("inflight");
    expect(bucketOf(it_({ status: "ready" }))).toBe("next");
    expect(bucketOf(it_({ status: "ready_to_settle" }))).toBe("live");
    expect(bucketOf(it_({ status: "exploring" }))).toBe("backlog");
    expect(bucketOf(it_({ status: "settled" }))).toBe("done");
    const d = { question: "Ship?", choices: [], askedAt: "" };
    expect(bucketOf(it_({ status: "ready", decision: d }))).toBe("owner");
    expect(bucketOf(it_({ status: "settled", decision: d }))).toBe("done");
  });
  it("rolls items up per area, skipping containers, conversations and archived rows", () => {
    const items = [
      it_({ id: "a", kind: "area", title: "Jarvis", updatedAt: "2026-10-01T00:00:00.000Z" }),
      it_({ id: "p", parentId: "a", kind: "project", title: "Map" }),
      it_({ id: "i1", parentId: "p", status: "in_progress", updatedAt: "2026-11-02T10:00:00.000Z" }),
      it_({ id: "i2", parentId: "p", status: "ready", decision: { question: "Q", choices: [], askedAt: "" } }),
      it_({ id: "i3", parentId: "a", status: "settled" }),
      it_({ id: "c", parentId: "a", kind: "conversation", status: "exploring" }),
      it_({ id: "z", parentId: "a", status: "ready", archived: true }),
      it_({ id: "b", kind: "area", title: "Home" }),
    ];
    const [j, h] = areaRollups(items);
    expect(j).toMatchObject({ id: "a", total: 3, projects: 1, lastActivity: "2026-11-02T10:00:00.000Z" });
    expect(j.counts).toMatchObject({ inflight: 1, owner: 1, done: 1, next: 0 });
    expect(h).toMatchObject({ id: "b", total: 0, projects: 0 });
  });
  it("filters by bucket, tag, assignee and text", () => {
    const i = it_({ title: "Fix map", nextAction: "Ship the cards", status: "in_progress", tags: ["ui"], assignee: "agent:devchief" });
    expect(matchesFilter(i, { bucket: "inflight", tag: "ui", assignee: "agent:devchief", q: "cards" })).toBe(true);
    expect(matchesFilter(i, { bucket: "next" })).toBe(false);
    expect(matchesFilter(i, { tag: "home" })).toBe(false);
    expect(matchesFilter(i, { assignee: "none" })).toBe(false);
    expect(matchesFilter(it_({}), { assignee: "none" })).toBe(true);
    expect(matchesFilter(i, { q: "nothing" })).toBe(false);
  });
});

describe("decision helpers (pure)", () => {
  it("validates, serialises and parses defensively", () => {
    expect(decisionInputSchema.safeParse({ question: " " }).success).toBe(false);
    const raw = serialiseDecision({ question: " Which DB? ", choices: ["A", "A", " B "] }, "2026-11-02T00:00:00.000Z");
    expect(parseDecision(raw)).toEqual({ question: "Which DB?", choices: ["A", "B"], askedAt: "2026-11-02T00:00:00.000Z" });
    expect(parseDecision("nope")).toBeNull();
    expect(parseDecision(null)).toBeNull();
    expect(parseDecision('{"question":""}')).toBeNull();
  });
  it("appends the answer to the summary", () => {
    expect(appendDecisionToSummary("", "Q?", "Yes", "2026-11-02T01:00:00.000Z")).toBe("- 2026-11-02 · Decision: Q? → Yes");
    expect(appendDecisionToSummary("Notes\n", "Q?", "No", "2026-11-02T01:00:00.000Z")).toBe("Notes\n\n- 2026-11-02 · Decision: Q? → No");
  });
  it("sorts newest first", () => {
    const e = (key: string, at: string) => ({ key, at }) as DecisionEntry;
    expect(sortDecisions([e("a", "1"), e("b", "3"), e("c", "2")]).map((x) => x.key)).toEqual(["b", "c", "a"]);
  });
});

describe("decisions inbox (server)", () => {
  let owner: string, other: string;
  const cid = "test";
  beforeEach(() => {
    __setTestDatabase();
    owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    other = createPerson({ name: "Robin", username: "robin", role: "adult", passcode: "synthetic-pass" }, owner).id;
  });
  afterEach(() => undefined);
  const userOf = (id: string) => resolveUser(new Headers(), createSession(id).token)!;

  it("aggregates item decisions, approvals and workflow proposals for the viewer only", () => {
    const u = userOf(owner);
    const area = store.createItem(u, { kind: "area", title: "Lagoon" }, cid);
    const item = store.createItem(u, { kind: "thread", title: "Pick a host", parentId: area.id }, cid);
    store.updateItem(u, item.id, { decision: { question: "Which host?", choices: ["Unraid", "VPS"] } }, cid);
    getDb()
      .insert(schema.runs)
      .values({
        runId: "r1",
        sessionId: "s1",
        userId: owner,
        idempotencyKey: "k1",
        status: "waiting_for_approval",
        pendingApproval: JSON.stringify({ description: "Run rm -rf build" }),
      })
      .run();
    const d = listDecisions(u);
    expect(d.count).toBe(2);
    const entry = d.entries.find((e) => e.kind === "item")!;
    expect(entry).toMatchObject({ title: "Pick a host", question: "Which host?", choices: ["Unraid", "VPS"], areaTitle: "Lagoon", itemId: item.id });
    expect(d.entries.find((e) => e.kind === "approval")).toMatchObject({ question: "Run rm -rf build", href: "/chat/s1" });
    expect(listDecisions(userOf(other)).count).toBe(0);
    // /map payload carries the same list plus items
    const m = mapData(u);
    expect(m.decisions.count).toBe(2);
    expect(m.items.find((i) => i.id === item.id)?.decision?.question).toBe("Which host?");
    const ex = mapExport(u, new Date("2026-11-02T00:00:00.000Z"));
    expect(ex.version).toBe(1);
    expect(ex.areas.find((a) => a.id === area.id)?.tree[0]).toMatchObject({ title: "Pick a host", bucket: "owner" });
  });

  it("answering logs activity, appends to the summary, never settles, and undoes cleanly", () => {
    const u = userOf(owner);
    const item = store.createItem(u, { kind: "thread", title: "Theme", summary: "Pick one" }, cid);
    store.updateItem(u, item.id, { decision: { question: "Tide or Lagoon?", choices: ["Tide", "Lagoon"] } }, cid);
    const out: store.OpOut = {};
    const after = store.answerDecision(u, item.id, "Lagoon", cid, out);
    expect(after.decision).toBeNull();
    expect(after.status).toBe(item.status);
    expect(after.summary).toMatch(/Pick one\n\n- \d{4}-\d{2}-\d{2} · Decision: Tide or Lagoon\? → Lagoon$/);
    expect(out.op?.kind).toBe("edit");
    const act = listActivity(u, { item: item.id });
    const row = act.items.find((a) => a.detail?.includes("Decision: Tide or Lagoon? → Lagoon"));
    expect(row?.undoOpId).toBe(out.op!.id);
    expect(listDecisions(u).count).toBe(0);
    // A second answer is refused (nothing pending).
    expect(() => store.answerDecision(u, item.id, "Tide", cid)).toThrow(/isn't waiting/);
    // Undo restores the question and the summary.
    store.undoOp(u, out.op!.id, cid);
    const back = store.listItems(owner).find((i) => i.id === item.id)!;
    expect(back.summary).toBe("Pick one");
    expect(back.decision?.question).toBe("Tide or Lagoon?");
    // Others can't answer it.
    expect(() => store.answerDecision(userOf(other), item.id, "Tide", cid)).toThrow();
  });
});
