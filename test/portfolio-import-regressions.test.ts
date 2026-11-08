import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { createItem, undoOp } from "@/server/work/store";
import { importPortfolioMap } from "@/server/work/portfolio-import";
import { planPortfolioImport, type PortfolioMap } from "@/lib/portfolio-import";

let user: CurrentUser;
let portfolio: string;
const map: PortfolioMap = {
  projects: [{ id: "jarvis", name: "Jarvis" }],
  nodes: [{ p: "jarvis", t: "Imported work", s: "backlog" }],
};
const row = (id: string) => getDb().select().from(schema.workItems).where(eq(schema.workItems.id, id)).get();

beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  user = resolveUser(new Headers(), createSession(id).token)!;
  portfolio = createItem(user, { kind: "area", title: "Portfolio" }, "test").id;
});

describe("portfolio import regression coverage", () => {
  it("reuses the Portfolio fallback even for a known project, including after the default container appears", () => {
    const first = importPortfolioMap(user, map, { apply: true }, "test");
    expect(first.applied?.created).toBe(2);
    expect(importPortfolioMap(user, map, { apply: true }, "test").applied).toEqual({ created: 0, updated: 0, links: 0 });
    const general = createItem(user, { kind: "area", title: "General Dev" }, "test");
    createItem(user, { kind: "project", parentId: general.id, title: "Jarvis" }, "test");
    const again = importPortfolioMap(user, { ...map, nodes: [{ ...map.nodes[0], g: "Follow ups" }] }, { apply: true }, "test");
    expect(again.applied).toEqual({ created: 0, updated: 1, links: 0 });
    expect(
      getDb()
        .select()
        .from(schema.workItems)
        .all()
        .filter((r) => r.title === "Imported work"),
    ).toHaveLength(1);
  });

  it("unions nodes matching one item into one update, one link insert and one original tag snapshot", () => {
    const project = createItem(user, { kind: "project", parentId: portfolio, title: "Jarvis" }, "test");
    const target = createItem(user, { kind: "thread", parentId: project.id, title: "Existing work" }, "test");
    getDb()
      .update(schema.workItems)
      .set({ tags: JSON.stringify(["original"]) })
      .where(eq(schema.workItems.id, target.id))
      .run();
    const link: [string, string] = ["Issue", "https://github.com/Owner/Repo/issues/3"];
    const imported = importPortfolioMap(
      user,
      {
        projects: map.projects,
        nodes: [
          { p: "jarvis", t: "Alias one", s: "next", g: "Lane one", l: [link] },
          { p: "jarvis", t: "Alias two", s: "next", g: "Lane two", l: [link, ["Doc", "https://example.com/Doc"]] },
        ],
      },
      { apply: true, aliases: { "Alias one": target.id, "Alias two": target.id } },
      "test",
    );
    expect(imported.plan.counts.update).toBe(1);
    expect(imported.applied).toEqual({ created: 0, updated: 1, links: 2 });
    const op = getDb().select().from(schema.workOps).where(eq(schema.workOps.id, imported.op!.id)).get()!;
    expect(JSON.parse(op.payload).tags).toEqual([{ id: target.id, prev: ["original"], next: ["original", "portfolio-map", "lane-one", "lane-two"] }]);
    expect(getDb().select().from(schema.workLinks).where(eq(schema.workLinks.itemId, target.id)).all()).toHaveLength(2);
    undoOp(user, imported.op!.id, "test");
    expect(JSON.parse(row(target.id)!.tags)).toEqual(["original"]);
    expect(getDb().select().from(schema.workLinks).where(eq(schema.workLinks.itemId, target.id)).all()).toHaveLength(0);
  });

  it("normalises scheme and host, but preserves path/query case and trailing path separators", () => {
    const plan = planPortfolioImport(
      {
        projects: [
          {
            id: "jarvis",
            name: "Jarvis",
            links: [
              ["same host", "HTTPS://EXAMPLE.COM/Doc?Key=Value"],
              ["path case", "https://example.com/doc?Key=Value"],
              ["query key case", "https://example.com/Doc?key=Value"],
              ["query value case", "https://example.com/Doc?Key=value"],
              ["slash", "https://example.com/Doc/?Key=Value"],
            ],
          },
        ],
        nodes: [],
      },
      {
        items: [
          { id: "p", parentId: null, kind: "area", title: "Portfolio", archived: false, tags: [] },
          { id: "j", parentId: "p", kind: "project", title: "Jarvis", archived: false, tags: [] },
        ],
        links: [{ itemId: "j", url: "https://EXAMPLE.com/Doc?Key=Value" }],
      },
    );
    expect(plan.entries[0].links.map((l) => l.title)).toEqual(["path case", "query key case", "query value case", "slash"]);
  });

  it.each(["incoming", "outgoing"])("archives an imported dependency endpoint (%s), preserving the edge", (direction) => {
    const external = createItem(user, { kind: "thread", parentId: portfolio, title: "Non imported" }, "test");
    const imported = importPortfolioMap(user, map, { apply: true }, "test");
    const target = getDb()
      .select()
      .from(schema.workItems)
      .all()
      .find((r) => r.title === "Imported work")!;
    getDb()
      .insert(schema.workDependencies)
      .values({
        id: "dep",
        userId: user.id,
        itemId: direction === "incoming" ? external.id : target.id,
        dependsOnId: direction === "incoming" ? target.id : external.id,
      })
      .run();
    undoOp(user, imported.op!.id, "test");
    expect(row(target.id)?.archived).toBe(true);
    expect(row(external.id)?.archived).toBe(false);
    expect(getDb().select().from(schema.workDependencies).all()).toHaveLength(1);
  });

  it.each(["forked_from", "split_from", "moved_from"])("archives an imported source of %s without losing lineage", (relation) => {
    const external = createItem(user, { kind: "thread", parentId: portfolio, title: "Non imported" }, "test");
    const imported = importPortfolioMap(user, map, { apply: true }, "test");
    const target = getDb()
      .select()
      .from(schema.workItems)
      .all()
      .find((r) => r.title === "Imported work")!;
    getDb().insert(schema.workLineage).values({ id: "lineage", userId: user.id, actor: user.id, childId: external.id, parentId: target.id, relation }).run();
    undoOp(user, imported.op!.id, "test");
    expect(row(target.id)?.archived).toBe(true);
    expect(getDb().select().from(schema.workLineage).all()).toMatchObject([{ childId: external.id, parentId: target.id }]);
  });

  it("also preserves an imported child referenced by external lineage", () => {
    const external = createItem(user, { kind: "thread", parentId: portfolio, title: "Non imported" }, "test");
    const imported = importPortfolioMap(user, map, { apply: true }, "test");
    const target = getDb()
      .select()
      .from(schema.workItems)
      .all()
      .find((r) => r.title === "Imported work")!;
    getDb()
      .insert(schema.workLineage)
      .values({ id: "lineage", userId: user.id, actor: user.id, childId: target.id, parentId: external.id, relation: "forked_from" })
      .run();
    undoOp(user, imported.op!.id, "test");
    expect(row(target.id)?.archived).toBe(true);
    expect(getDb().select().from(schema.workLineage).all()).toHaveLength(1);
  });
});
