/** Phase 4 lane 3: portfolio map import (planner + apply + undo) and the Portfolio view rows. */
import { beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { importPortfolioMap } from "@/server/work/portfolio-import";
import {
  cleanTitle,
  laneTag,
  mapStatus,
  nodeTitle,
  planLink,
  planPortfolioImport,
  portfolioImportSchema,
  titlesMatch,
  type ExistingItem,
  type PortfolioMap,
} from "@/lib/portfolio-import";
import { portfolioRows, portfolioTags, shortVersion } from "@/lib/portfolio-view";
import { listDecisions } from "@/server/work/decisions";
import type { WorkItem } from "@/lib/work";

const MAP: PortfolioMap = {
  title: "Portfolio project map",
  projects: [
    { id: "jarvis", name: "Jarvis", links: [["Repo", "https://github.com/NickBolles/Personal-dashboard"]] },
    { id: "momentum", name: "Momentum Bets", links: [] },
    { id: "shopify", name: "Shopify", links: [] },
    { id: "garden", name: "Garden", summary: "Raised beds", links: [] },
  ],
  nodes: [
    {
      p: "jarvis",
      g: "Master plan 2026-11-04 (rev 2 — Phases 0–2 LIVE)",
      t: "Phase 1 · Global coordinator + quick actions (LIVE)",
      s: "live",
      u: "2026-11-04",
      sum: "Shipped.",
      l: [
        ["#193", "https://github.com/NickBolles/Personal-dashboard/pull/193"],
        ["Board", "https://artifacts.ai.nickbolles.com/v/jarvis-global-coordinator/"],
      ],
    },
    {
      p: "jarvis",
      g: "Workflows",
      t: "Workflows W1–W4 (owner-requested)",
      s: "inflight",
      sum: "Four PRs. Then more.",
      l: [["Roadmap", "file:/opt/data/x.md"]],
    },
    {
      p: "jarvis",
      g: "Follow-ups (open GitHub issues)",
      t: "Chat — 1 open",
      s: "backlog",
      l: [["#176", "https://github.com/NickBolles/Personal-dashboard/issues/176"]],
    },
    { p: "jarvis", g: "Open issues by label (after the batch)", t: "follow-up — 6 open", s: "backlog", l: [] },
    {
      p: "momentum",
      g: "Top items",
      t: "Criteria evaluator V5 → authoritative rollout",
      s: "inflight",
      l: [["#1517", "https://github.com/momentumbets/mb-stack/issues/1517"]],
    },
    { p: "shopify", g: "Apps", t: "3 Shopify apps", s: "owner", sum: "Waiting on you." },
    { p: "garden", g: "Beds", t: "Order soil", s: "next", sum: "Two cubic yards." },
    { p: "garden", g: "Beds", t: "Order soil", s: "next", l: [["Shop", "https://example.com/soil"]] },
    { p: "nowhere", g: "X", t: "Orphan", s: "next" },
  ],
  ownerBlocked: [{ t: "Rotate the Caskfolk DB password", d: "Runbook ready; needs your approval to run." }],
};

const area = (id: string, title: string): ExistingItem => ({ id, parentId: null, kind: "area", title, archived: false, tags: [] });
const node = (id: string, parentId: string, title: string, kind = "thread", tags: string[] = []): ExistingItem => ({
  id,
  parentId,
  kind,
  title,
  archived: false,
  tags,
});

const TREE: ExistingItem[] = [
  area("gd", "General Dev"),
  node("jv", "gd", "Jarvis", "project"),
  node("sh", "gd", "Shopify apps", "project"),
  area("mb", "Momentum bets"),
  node("v5", "mb", "Criteria evaluator V5", "project"),
  area("pf", "Portfolio"),
  area("fin", "Finance"),
];

describe("portfolio import planner (pure)", () => {
  it("cleans titles, matches by words and prefix, and maps lanes/statuses", () => {
    expect(cleanTitle("Phase 1 · Global coordinator (LIVE)")).toBe("Phase 1 · Global coordinator");
    expect(nodeTitle("Chat — 1 open")).toBe("Chat follow-ups");
    expect(nodeTitle("Phase 2 follow-ups — 3 open + 1 flaky test")).toBe("Phase 2 follow-ups");
    expect(titlesMatch("Results & grading", "Results and grading rollout acceptance")).toBe(true);
    expect(titlesMatch("Jarvis", "Jarvis map")).toBe(false); // too short for a prefix match
    expect(titlesMatch("Phase 2 — chat", "Phase 2 · Chat")).toBe(true);
    expect(laneTag("Master plan 2026-11-04 (rev 2 — Phases 0–2 LIVE)")).toBe("master-plan-2026-11-04");
    expect(laneTag("Original roadmap — not started")).toBe("original-roadmap");
    for (const s of ["live", "done", "inflight", "next", "backlog", "owner", "weird"])
      expect(["settled", "abandoned", "superseded"]).not.toContain(mapStatus(s));
    expect(planLink("x", "file:/opt/data/a.md")).toBeNull();
    expect(planLink("x", "http://example.com")).toBeNull();
    expect(planLink("PR", "https://github.com/a/b/pull/7/")?.kind).toBe("github_pr");
    expect(planLink("", "https://github.com/a/b/issues/8")).toMatchObject({ kind: "github_issue", title: "github.com" });
  });

  it("plans containers, items, owner asks; skips derived groups, unknown projects and duplicates", () => {
    const plan = planPortfolioImport(MAP, { items: TREE, links: [] });
    const by = (k: string) => plan.entries.find((e) => e.key === k)!;
    // existing containers gain links only
    expect(by("project:jarvis")).toMatchObject({ action: "update", matchedId: "jv", links: [{ kind: "url" }] });
    expect(by("project:momentum")).toMatchObject({ action: "skip", matchedId: "mb", reason: "already in Jarvis" });
    // a project with no container lands under Portfolio
    expect(by("project:garden")).toMatchObject({ action: "create", kind: "project", parentId: "pf", status: "in_progress" });
    const p1 = by("node:0");
    expect(p1).toMatchObject({ action: "create", parentId: "jv", status: "ready_to_settle", title: "Phase 1 · Global coordinator + quick actions" });
    expect(p1.tags).toEqual(["portfolio-map", "master-plan-2026-11-04"]);
    expect(p1.links.map((l) => l.kind)).toEqual(["github_pr", "url"]);
    expect(by("node:1")).toMatchObject({ status: "in_progress", nextAction: "Four PRs." });
    expect(by("node:2").title).toBe("Chat follow-ups");
    expect(by("node:3")).toMatchObject({ action: "skip" });
    // prefix match on an existing project: no duplicate, only the new link
    expect(by("node:4")).toMatchObject({ action: "update", matchedId: "v5", links: [{ kind: "github_issue" }] });
    expect(by("node:5")).toMatchObject({ action: "create", parentId: "sh", decision: { question: "3 Shopify apps: what's the call?" } });
    // same title twice on the board → one item with both links
    expect(by("node:6")).toMatchObject({ action: "create", parentKey: "project:garden" });
    expect(by("node:6").links).toHaveLength(1);
    expect(by("node:7")).toMatchObject({ action: "skip" });
    expect(by("node:8")).toMatchObject({ action: "skip" });
    expect(by("ask:0")).toMatchObject({ action: "create", parentId: "pf", decision: { question: "Rotate the Caskfolk DB password" } });
    expect(plan.skippedLinks).toBe(1);
    expect(plan.entries.some((e) => e.parentId === "fin")).toBe(false);
  });

  it("is idempotent against its own result and honours aliases", () => {
    const plan = planPortfolioImport(MAP, { items: TREE, links: [] });
    // Simulate the applied import: every create exists, every link is stored.
    const items: ExistingItem[] = [...TREE];
    const links: { itemId: string; url: string }[] = [];
    const ids = new Map<string, string>();
    for (const e of plan.entries) {
      if (e.action === "create") {
        const id = `new-${e.key}`;
        ids.set(e.key, id);
        items.push({ id, parentId: e.parentId ?? ids.get(e.parentKey!)!, kind: e.kind, title: e.title, archived: false, tags: e.tags });
        for (const l of e.links) links.push({ itemId: id, url: l.url });
      } else if (e.action === "update") {
        for (const l of e.links) links.push({ itemId: e.matchedId!, url: l.url });
        const it = items.find((i) => i.id === e.matchedId)!;
        it.tags = [...it.tags, ...e.tags];
      }
    }
    const again = planPortfolioImport(MAP, { items, links });
    expect(again.counts.create).toBe(0);
    expect(again.counts.update).toBe(0);

    const aliased = planPortfolioImport(
      MAP,
      { items: [...TREE, node("gc", "jv", "Global coordinator — Chief of staff on every screen")], links: [] },
      {
        aliases: { "Phase 1 · Global coordinator + quick actions (LIVE)": "gc" },
      },
    );
    expect(aliased.entries.find((e) => e.key === "node:0")).toMatchObject({ action: "update", matchedId: "gc" });
    const bad = planPortfolioImport(MAP, { items: TREE, links: [] }, { aliases: { "Order soil": "missing" } });
    expect(bad.notes.some((n) => n.includes("missing"))).toBe(true);
  });

  it("never imports into Finance", () => {
    const plan = planPortfolioImport(
      { projects: [{ id: "money", name: "Budget" }], nodes: [{ p: "money", t: "Pay taxes", s: "next" }] },
      { items: TREE, links: [] },
      { targets: { money: ["Finance"] } },
    );
    expect(plan.counts.create).toBe(0);
    expect(plan.entries.every((e) => e.action === "skip")).toBe(true);
  });

  it("validates the request body", () => {
    expect(portfolioImportSchema.safeParse({ map: MAP }).success).toBe(true);
    expect(portfolioImportSchema.safeParse({ map: MAP, extra: 1 }).success).toBe(false);
    expect(portfolioImportSchema.safeParse({ map: { projects: [], nodes: [{ p: "x", t: "", s: "next" }] } }).success).toBe(false);
  });
});

describe("portfolio import (server)", () => {
  let owner: string;
  const cid = "test";
  beforeEach(() => {
    __setTestDatabase();
    owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  });
  const userOf = (id: string) => resolveUser(new Headers(), createSession(id).token)!;
  const seed = () => {
    const u = userOf(owner);
    const gd = store.createItem(u, { kind: "area", title: "General Dev" }, cid);
    const jv = store.createItem(u, { kind: "project", title: "Jarvis", parentId: gd.id }, cid);
    store.createItem(u, { kind: "project", title: "Shopify apps", parentId: gd.id }, cid);
    const mb = store.createItem(u, { kind: "area", title: "Momentum bets" }, cid);
    const v5 = store.createItem(u, { kind: "project", title: "Criteria evaluator V5", parentId: mb.id }, cid);
    store.createItem(u, { kind: "area", title: "Portfolio" }, cid);
    store.createItem(u, { kind: "area", title: "Finance" }, cid);
    return { u, jv, v5 };
  };
  const count = () => getDb().select().from(schema.workItems).all().length;

  it("dry run writes nothing; apply adds items/links/decisions; a second run is a no-op; undo removes it all", () => {
    const { u, v5 } = seed();
    const before = count();
    const dry = importPortfolioMap(u, MAP, {}, cid);
    expect(dry.applied).toBeNull();
    expect(count()).toBe(before);

    const res = importPortfolioMap(u, MAP, { apply: true }, cid);
    expect(res.applied!.created).toBe(dry.plan.counts.create);
    expect(res.op?.kind).toBe("import");
    expect(count()).toBe(before + dry.plan.counts.create);
    const rows = getDb().select().from(schema.workItems).all();
    expect(rows.some((r) => ["settled", "abandoned", "superseded"].includes(r.status))).toBe(false);
    const p1 = rows.find((r) => r.title === "Phase 1 · Global coordinator + quick actions")!;
    expect(p1.status).toBe("ready_to_settle");
    expect(JSON.parse(p1.tags)).toContain("master-plan-2026-11-04");
    // the owner asks show up in Needs you
    const titles = listDecisions(u).entries.map((e) => e.title);
    expect(titles).toEqual(expect.arrayContaining(["Rotate the Caskfolk DB password", "3 Shopify apps"]));
    // existing project gained the link + lane tags, nothing else
    const v5Row = rows.find((r) => r.id === v5.id)!;
    expect(v5Row.title).toBe("Criteria evaluator V5");
    expect(JSON.parse(v5Row.tags)).toEqual(["portfolio-map", "top-items"]);
    expect(
      getDb()
        .select()
        .from(schema.workLinks)
        .all()
        .filter((l) => l.itemId === v5.id),
    ).toHaveLength(1);

    const mid = count(); // (listDecisions may have created the built-in Miscellaneous area)
    const again = importPortfolioMap(u, MAP, { apply: true }, cid);
    expect(again.applied).toMatchObject({ created: 0, updated: 0, links: 0 });
    expect(count()).toBe(mid);

    // Nothing to do = no Undo op; the first import stays the latest and can still be undone.
    expect(again.op).toBeUndefined();
    store.undoOp(u, res.op!.id, cid);
    expect(count()).toBe(mid - dry.plan.counts.create);
    expect(() => store.undoOp(u, res.op!.id, cid)).toThrow(/undone/i);
  });

  it("undo deletes untouched new items and links, restores tags, archives touched ones", () => {
    const { u, v5 } = seed();
    const before = count();
    const res = importPortfolioMap(u, MAP, { apply: true }, cid);
    const touched = getDb()
      .select()
      .from(schema.workItems)
      .all()
      .find((r) => r.title === "Order soil")!;
    store.updateItem(u, touched.id, { nextAction: "Call the yard" }, cid);
    store.undoOp(u, res.op!.id, cid);
    const rows = getDb().select().from(schema.workItems).all();
    // everything new is gone except the touched item (archived) and its parent project (has a child)
    expect(rows.find((r) => r.id === touched.id)?.archived).toBe(true);
    expect(rows.filter((r) => !r.archived).length).toBe(before);
    expect(JSON.parse(rows.find((r) => r.id === v5.id)!.tags)).toEqual([]);
    expect(
      getDb()
        .select()
        .from(schema.workLinks)
        .all()
        .filter((l) => l.itemId === v5.id),
    ).toHaveLength(0);
  });
});

describe("portfolio view rows (pure)", () => {
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
  const w = (o: Partial<WorkItem>): WorkItem => ({ ...base, ...o });
  const items = [
    w({ id: "gd", kind: "area", title: "General Dev" }),
    w({ id: "jv", kind: "project", parentId: "gd", title: "Jarvis" }),
    w({ id: "a", parentId: "jv", status: "in_progress", tags: ["phase-4"], updatedAt: "2026-11-06T00:00:00.000Z" }),
    w({ id: "a2", parentId: "a", status: "ready" }),
    w({ id: "b", parentId: "jv", status: "settled" }),
    w({ id: "c", parentId: "jv", status: "ready", decision: { question: "Q", choices: [], askedAt: "" } }),
    w({ id: "h", kind: "area", title: "Home" }),
    w({ id: "e", parentId: "h", status: "captured" }),
    w({ id: "fin", kind: "area", title: "Finance" }),
    w({ id: "f", parentId: "fin", status: "in_progress" }),
    w({ id: "z", parentId: "h", status: "ready", archived: true }),
    w({ id: "conv", parentId: "h", kind: "conversation" }),
  ];
  it("groups work by nearest container into lanes, leaves Finance out, owner rows first", () => {
    const rows = portfolioRows(items);
    expect(rows.map((r) => r.title)).toEqual(["Jarvis", "Home"]);
    const jv = rows[0];
    expect(jv.path).toBe("General Dev");
    expect(jv.lanes.owner.map((i) => i.id)).toEqual(["c"]);
    expect(jv.lanes.inflight.map((i) => i.id)).toEqual(["a"]);
    expect(jv.lanes.next.map((i) => i.id)).toEqual(["a2"]);
    expect(jv.counts.done).toBe(1);
    expect(jv.open).toBe(3);
    expect(jv.updatedAt).toBe("2026-11-06T00:00:00.000Z");
    expect(rows[1].lanes.backlog.map((i) => i.id)).toEqual(["e"]);
  });
  it("filters by tag and lists tags; shortens SHAs", () => {
    expect(portfolioRows(items, { tag: "phase-4" }).map((r) => r.open)).toEqual([1]);
    expect(portfolioTags(items)).toEqual(["phase-4"]);
    expect(shortVersion("b4c633fbd8d0edef0d20b1fbf887012c193f579e")).toBe("b4c633f");
    expect(shortVersion("dev")).toBe("dev");
  });
});
