import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { createLocalSession } from "@/server/assistant/local";
import { applyTemplate, filingTokens, handoffMarkdown, isValidationOverdue, packetSchema, shiftDates, suggestFiling } from "@/lib/work";
import { addWidget, getDashboard } from "@/server/work/dashboard";
import { localDate, addDays } from "@/lib/time";
import { config } from "@/server/config";
import * as templatesRoute from "@/app/api/work/validation-templates/route";
import * as fromTemplateRoute from "@/app/api/work/items/[id]/validations/from-template/route";
import { wouldCreateDependencyCycle } from "@/server/work/lifecycle";
import * as depsRoute from "@/app/api/work/items/[id]/dependencies/route";
import * as depRoute from "@/app/api/work/dependencies/[id]/route";
import { getSessionDetail } from "@/server/assistant";
import { recentAudit } from "@/server/audit";
import * as continueRoute from "@/app/api/work/items/[id]/continue/route";
import * as ghRefreshRoute from "@/app/api/work/github/refresh/route";
import { dueForRefresh, REFRESH_INTERVAL_MS } from "@/server/work/refresh-rules";
import { descendantsOf, planPlacement } from "@/server/work/tree-rules";
import * as placeRoute from "@/app/api/work/items/[id]/place/route";
import * as undoRoute from "@/app/api/work/ops/[id]/undo/route";
import * as moveRoute from "@/app/api/work/items/[id]/move/route";
import { isUntouched, latestOp, undoCheck, UNDO_WINDOW_MS } from "@/server/work/undo-rules";
import * as store from "@/server/work/store";
import * as conversations from "@/server/work/conversations";
import * as conversationsRoute from "@/app/api/work/conversations/route";
import * as unfiledRoute from "@/app/api/work/conversations/unfiled/route";
import * as fileRoute from "@/app/api/work/conversations/file/route";

/** Work hub phase 2 (docs/work.md): pure rules, store behaviour and API boundaries. */

let owner: string, other: string, kid: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const them = () => resolveUser(new Headers(), createSession(other).token)!;

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  kid = createPerson({ name: "Child", username: "child", role: "kid", passcode: "synthetic-pass" }, owner).id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function flagship() {
  const u = me();
  const area = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
  const project = store.createItem(u, { kind: "project", title: "Criteria evaluator", parentId: area.id }, cid);
  const items = ["V2 baseline", "V3 parity", "V4 lessons", "V5 evaluator contract"].map((title) =>
    store.createItem(u, { kind: "thread", title, parentId: project.id }, cid),
  );
  return { u, area, project, v2: items[0]!, v3: items[1]!, v4: items[2]!, v5: items[3]! };
}

async function call(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  opts: { user?: string | null; method?: string; body?: unknown; csrf?: boolean; params?: Record<string, string>; query?: string } = {},
) {
  const { user = owner, method = "GET", body, csrf = true, params = {}, query = "" } = opts;
  return handler(
    new NextRequest(`http://jarvis.test/api/work${query}`, {
      method,
      headers: {
        ...(user ? { cookie: `jarvis_session=${createSession(user).token}` } : {}),
        ...(csrf ? { "x-jarvis-csrf": "1" } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}
type H = Parameters<typeof call>[0];

describe("filing suggestions (pure)", () => {
  it("tokenizes significant words, keeping short words with digits", () => {
    expect(filingTokens("Enable the V5 rollout, please!")).toEqual(["enable", "v5", "rollout"]);
    expect(filingTokens("a an of to")).toEqual([]);
    expect(filingTokens("Café Q3 plan")).toEqual(["cafe", "q3", "plan"]);
  });

  it("matches exact title words deterministically and skips closed and built-in items", () => {
    const c = (id: string, title: string, status = "captured", builtIn = false) => ({ id, title, path: `A › ${title}`, status: status as "captured", builtIn });
    const items = [
      c("1", "V5 evaluator contract"),
      c("2", "V5"),
      c("3", "Evaluator rollout plan"),
      c("4", "V5 rollout", "settled"),
      c("5", "Miscellaneous", "captured", true),
      c("6", "Hydration perf bug"),
    ];
    const s = suggestFiling("Enable v5 rollout", items);
    expect(s.map((x) => x.id)).toEqual(["2", "3", "1"]);
    expect(s[0]!.matched).toEqual(["v5"]);
    // Same input in another order gives the same answer.
    expect(suggestFiling("Enable v5 rollout", [...items].reverse()).map((x) => x.id)).toEqual(["2", "3", "1"]);
    expect(suggestFiling("Morning planning", items)).toEqual([]);
    expect(suggestFiling("", items)).toEqual([]);
  });
});

describe("conversations (picker, unfiled, filing)", () => {
  it("lists your conversations, finds unfiled ones with suggestions, and files them", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
    const { u, v5 } = flagship();
    const a = createLocalSession(u, "Enable v5 rollout");
    const b = createLocalSession(u, "Morning planning");
    const theirs = createLocalSession(them(), "Their v5 notes");

    const list = await conversations.listConversations(u);
    expect(list.conversations.map((c) => c.title).sort()).toEqual(["Enable v5 rollout", "Morning planning"]);
    expect(list.conversations.every((c) => c.backend === "claude")).toBe(true);
    expect((await conversations.listConversations(u, "morning")).conversations.map((c) => c.id)).toEqual([b.id]);

    let unfiled = await conversations.unfiledConversations(u);
    expect(unfiled.total).toBe(2);
    expect(unfiled.conversations.find((c) => c.id === a.id)!.suggestions[0]).toMatchObject({ id: v5.id, matched: ["v5"] });
    expect(unfiled.conversations.find((c) => c.id === b.id)!.suggestions).toEqual([]);

    const filed = await conversations.fileConversation(u, { sessionId: a.id, itemId: v5.id }, cid);
    expect(filed.link).toMatchObject({ kind: "chat_session", targetId: a.id, role: "source", title: "Enable v5 rollout" });
    const misc = await conversations.fileConversation(u, { sessionId: b.id, itemId: null }, cid);
    expect(store.getDetail(owner, misc.itemId).item.builtIn).toBe(true);
    unfiled = await conversations.unfiledConversations(u);
    expect(unfiled.total).toBe(0);
    const linked = (await conversations.listConversations(u)).conversations.find((c) => c.id === a.id)!;
    expect(linked.linkedItems).toEqual([{ id: v5.id, title: "V5 evaluator contract" }]);

    // The same conversation can't be linked twice to one item; others' private chats can't be linked at all.
    await expect(conversations.fileConversation(u, { sessionId: a.id, itemId: v5.id }, cid)).rejects.toThrow(/already linked/);
    await expect(conversations.fileConversation(u, { sessionId: theirs.id, itemId: v5.id }, cid)).rejects.toThrow(/not found/);
    // Other people's items are not found.
    await expect(conversations.fileConversation(them(), { sessionId: theirs.id, itemId: v5.id }, cid)).rejects.toThrow(/not found/);
  });

  it("enforces work.use and hermes.chat at the API", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
    expect((await call(conversationsRoute.GET as H, { user: null })).status).toBe(401);
    expect((await call(conversationsRoute.GET as H, { user: kid })).status).toBe(403);
    const ok = await call(unfiledRoute.GET as H);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ total: 0, conversations: [] });
    expect((await call(fileRoute.POST as H, { method: "POST", body: { sessionId: "x", itemId: null }, csrf: false })).status).toBe(403);
    expect((await call(fileRoute.POST as H, { method: "POST", body: { sessionId: "x" } })).status).toBe(400);
    expect((await call(conversationsRoute.GET as H, { query: "?q=v5" })).status).toBe(200);
  });
});

describe("continue in a new conversation", () => {
  it("creates a conversation via the assistant layer, links it as source with handoff_from lineage, and sends nothing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
    const { u, v5 } = flagship();
    store.createPacket(u, v5.id, packetSchema.parse({ objective: "Define V5", nextAction: "Open the PR" }), cid);
    const p2 = store.createPacket(u, v5.id, packetSchema.parse({ objective: "Define V5 (rev)", nextAction: "Open the PR" }), cid);
    const r = await store.continueInConversation(u, v5.id, "claude", cid);
    expect(r.session.id).toMatch(/^loc_/);
    expect(r.link).toMatchObject({ kind: "chat_session", role: "source", lineage: "handoff_from", packetId: p2.id, targetId: r.session.id });
    const d = store.getDetail(owner, v5.id);
    expect(d.events.find((e) => e.kind === "handoff")?.reason).toBe("Continued in a new conversation (handoff from packet v2)");
    expect(recentAudit(50).some((a) => a.action === "work.handoff")).toBe(true);
    // The draft is only pre-filled in the browser: the conversation has no messages and no run.
    const s = await getSessionDetail(u, r.session.id);
    expect(s.timeline).toEqual([]);
    expect(s.session.activeRun).toBeUndefined();
    // The handoff the browser pre-fills is the same Markdown as "Copy handoff".
    expect(handoffMarkdown(d, "https://jarvis.test")).toContain("# Handoff: V5 evaluator contract");
    // Forking doesn't copy the handoff lineage.
    const fork = store.forkItem(u, v5.id, undefined, cid);
    expect(store.getDetail(owner, fork.id).links[0]).toMatchObject({ lineage: null, packetId: null });
  });

  it("needs work.use, hermes.chat, ownership and an available backend", async () => {
    const { v5 } = flagship();
    expect((await call(continueRoute.POST as H, { user: kid, method: "POST", params: { id: v5.id }, body: {} })).status).toBe(403);
    expect((await call(continueRoute.POST as H, { user: other, method: "POST", params: { id: v5.id }, body: {} })).status).toBe(404);
    // Claude isn't set up in this test: refused, and no link is written.
    expect((await call(continueRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { backend: "claude" } })).status).toBe(409);
    expect(store.getDetail(owner, v5.id).links).toEqual([]);
    expect((await call(continueRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { backend: "gpt" } })).status).toBe(400);
  });
});

describe("automatic GitHub refresh", () => {
  it("picks due links: GitHub only, not merged PRs, throttled per link, oldest first, capped", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const l = (id: string, kind: string, externalState: string | null, checkedAt: string | null, url: string | null = "https://github.com/o/r/pull/1") => ({
      id,
      kind,
      url,
      externalState,
      checkedAt,
    });
    const links = [
      l("a", "github_pr", "open", null),
      l("b", "github_pr", "merged", null),
      l("c", "github_issue", "closed", ago(REFRESH_INTERVAL_MS)),
      l("d", "github_pr", "open", ago(REFRESH_INTERVAL_MS - 1)),
      l("e", "url", null, null),
      l("f", "github_pr", "closed", ago(10 * REFRESH_INTERVAL_MS)),
      l("g", "github_pr", "open", null, null),
    ];
    expect(dueForRefresh(links, now)).toEqual(["a", "f", "c"]);
    expect(dueForRefresh(links, now, { max: 2 })).toEqual(["a", "f"]);
    expect(dueForRefresh([...links].reverse(), now)).toEqual(["a", "f", "c"]);
  });

  it("refreshes at most 10 links per request with at most 4 in flight, and applies a merge exactly once", async () => {
    const { u, project, v5 } = flagship();
    const impl = await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/o/r/pull/100" }, cid);
    const issue = await store.addLink(u, v5.id, { kind: "github_issue", url: "https://github.com/o/r/issues/200" }, cid);
    for (let n = 1; n <= 10; n++) await store.addLink(u, project.id, { kind: "github_pr", url: `https://github.com/o/r/pull/${n}`, role: "reference" }, cid);
    expect(await store.autoRefreshLinks(u, {}, cid)).toEqual({ enabled: false, checked: 0, changed: 0, errors: 0 });

    vi.stubEnv("JARVIS_GITHUB_TOKEN", "synthetic-test-value");
    let inFlight = 0;
    let peak = 0;
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(init.method).toBe("GET");
        urls.push(url);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (url.endsWith("/pulls/100")) return Response.json({ state: "closed", merged: true, title: "Evaluator V5" });
        if (url.endsWith("/issues/200")) return Response.json({ state: "closed", title: "Tracking issue" });
        if (url.endsWith("/pulls/7")) return new Response("nope", { status: 500 });
        return Response.json({ state: "open", merged: false });
      }),
    );
    const t0 = new Date();
    const first = await store.autoRefreshLinks(u, {}, cid, t0);
    expect(first).toMatchObject({ enabled: true, checked: 10 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    const second = await store.autoRefreshLinks(u, {}, cid, t0);
    expect(second.checked).toBe(2); // the two never-checked links; everything else is throttled
    expect(await store.autoRefreshLinks(u, {}, cid, t0)).toMatchObject({ checked: 0 });
    expect(new Set(urls).size).toBe(urls.length); // nothing read twice inside the window
    expect(urls).toContain("https://api.github.com/repos/o/r/issues/200");

    let d = store.getDetail(owner, v5.id);
    expect(d.item.status).toBe("awaiting_validation");
    expect(d.links.find((l) => l.id === impl.id)).toMatchObject({ externalState: "merged", title: "Evaluator V5 (#100)", checkError: null });
    expect(d.links.find((l) => l.id === issue.id)).toMatchObject({ externalState: "closed" });
    const statusEvents = () => store.getDetail(owner, v5.id).events.filter((e) => e.kind === "status");
    expect(statusEvents()).toHaveLength(1);
    expect(statusEvents()[0]).toMatchObject({ toStatus: "awaiting_validation", source: "github" });
    expect(d.events.find((e) => e.kind === "merged")).toMatchObject({ source: "github" });
    const failed = store.getDetail(owner, project.id).links.find((l) => l.url?.endsWith("/pull/7"))!;
    expect(failed.checkError).toMatch(/GitHub answered 500/);

    // After the interval, open links are read again; the merged PR is final and never re-read; no second transition.
    const later = new Date(t0.getTime() + REFRESH_INTERVAL_MS + 1000);
    const again = await store.autoRefreshLinks(u, { itemId: v5.id }, cid, later);
    expect(again).toMatchObject({ checked: 1, changed: 0 }); // only the issue
    expect(statusEvents()).toHaveLength(1);
    d = store.getDetail(owner, v5.id);
    expect(d.item.status).toBe("awaiting_validation");
  });

  it("concurrent refreshes claim each link once", async () => {
    const { u, v5 } = flagship();
    for (let n = 1; n <= 6; n++) await store.addLink(u, v5.id, { kind: "github_pr", url: `https://github.com/o/r/pull/${n}` }, cid);
    vi.stubEnv("JARVIS_GITHUB_TOKEN", "synthetic-test-value");
    const fetchMock = vi.fn(async () => Response.json({ state: "closed", merged: true }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date();
    const [a, b] = await Promise.all([store.autoRefreshLinks(u, {}, cid, now), store.autoRefreshLinks(u, {}, cid, now)]);
    expect(a.checked + b.checked).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(store.getDetail(owner, v5.id).events.filter((e) => e.kind === "status" && e.toStatus === "awaiting_validation")).toHaveLength(1);
  });

  it("is scoped to your items at the API", async () => {
    const { v5 } = flagship();
    expect((await call(ghRefreshRoute.POST as H, { method: "POST", body: {} })).status).toBe(200);
    expect((await call(ghRefreshRoute.POST as H, { user: kid, method: "POST", body: {} })).status).toBe(403);
    vi.stubEnv("JARVIS_GITHUB_TOKEN", "synthetic-test-value");
    expect((await call(ghRefreshRoute.POST as H, { user: other, method: "POST", body: { itemId: v5.id } })).status).toBe(404);
    expect((await call(ghRefreshRoute.POST as H, { method: "POST", body: { itemId: v5.id, x: 1 } })).status).toBe(400);
  });
});

describe("drag-and-drop placement", () => {
  it("plans sibling order with clamping and keeps Miscellaneous last (pure)", () => {
    const sib = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "misc", builtIn: true }];
    expect(planPlacement(sib, "x", 0)).toEqual(["x", "a", "b", "c", "misc"]);
    expect(planPlacement(sib, "b", 0)).toEqual(["b", "a", "c", "misc"]);
    expect(planPlacement(sib, "a", 2)).toEqual(["b", "c", "a", "misc"]);
    expect(planPlacement(sib, "a", 99)).toEqual(["b", "c", "a", "misc"]);
    expect(planPlacement(sib, "a", -3)).toEqual(["a", "b", "c", "misc"]);
    const parents = new Map<string, string | null>([
      ["area", null],
      ["p", "area"],
      ["t", "p"],
      ["t2", "t"],
      ["other", "area"],
    ]);
    expect([...descendantsOf(parents, "p")].sort()).toEqual(["p", "t", "t2"]);
  });

  it("reorders among siblings and re-parents cycle-safely with moved_from lineage", () => {
    const { u, area, project, v2, v3, v4, v5 } = flagship();
    const kids = (pid: string) =>
      store
        .listItems(owner)
        .filter((i) => i.parentId === pid)
        .map((i) => i.title);
    store.placeItem(u, v5.id, { parentId: project.id, index: 0 }, cid);
    expect(kids(project.id)).toEqual(["V5 evaluator contract", "V2 baseline", "V3 parity", "V4 lessons"]);
    expect(store.getDetail(owner, v5.id).events[0]).toMatchObject({ kind: "reordered" });
    expect(store.getDetail(owner, v5.id).lineage).toEqual([]);

    store.placeItem(u, v2.id, { parentId: v4.id, index: 0 }, cid);
    expect(kids(v4.id)).toEqual(["V2 baseline"]);
    expect(store.getDetail(owner, v2.id).lineage[0]).toMatchObject({ relation: "moved_from", fromParentId: project.id, toParentId: v4.id });
    expect(() => store.placeItem(u, project.id, { parentId: v4.id, index: 0 }, cid)).toThrow(/inside itself/);
    expect(() => store.placeItem(u, v3.id, { parentId: null, index: 0 }, cid)).toThrow(/Only areas/);
    const misc = store.listItems(owner).find((i) => i.builtIn)!;
    expect(() => store.placeItem(u, misc.id, { parentId: null, index: 0 }, cid)).toThrow(/built in/);
    // Areas: Miscellaneous stays last even when dropped "after" it.
    const second = store.createItem(u, { kind: "area", title: "Home" }, cid);
    store.placeItem(u, area.id, { parentId: null, index: 99 }, cid);
    expect(
      store
        .listItems(owner)
        .filter((i) => i.parentId === null)
        .map((i) => i.title),
    ).toEqual([second.title, "Momentum Bets", "Miscellaneous"]);
  });

  it("validates at the API", async () => {
    const { project, v5 } = flagship();
    expect((await call(placeRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { parentId: project.id, index: -1 } })).status).toBe(400);
    expect((await call(placeRoute.POST as H, { user: other, method: "POST", params: { id: v5.id }, body: { parentId: project.id, index: 0 } })).status).toBe(
      404,
    );
    expect((await call(placeRoute.POST as H, { method: "POST", params: { id: project.id }, body: { parentId: v5.id, index: 0 } })).status).toBe(409);
    expect((await call(placeRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { parentId: project.id, index: 1 } })).status).toBe(200);
  });
});

describe("undo for structural operations", () => {
  it("allows undo once, only for the item's latest operation, within the window (pure)", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    const op = { id: "b", createdAt: "2026-10-22T11:59:00.000Z", undoneAt: null };
    expect(undoCheck(op, "b", now)).toEqual({ ok: true });
    expect(undoCheck({ ...op, undoneAt: "2026-10-22T11:59:30.000Z" }, "b", now)).toMatchObject({ ok: false, code: "already_undone" });
    expect(undoCheck(op, "c", now)).toMatchObject({ ok: false, code: "superseded" });
    expect(undoCheck(op, "b", new Date(now.getTime() + UNDO_WINDOW_MS))).toMatchObject({ ok: false, code: "expired" });
    expect(
      latestOp([{ id: "a", createdAt: "2026-10-22T11:00:00.000Z", undoneAt: null }, { id: "c", createdAt: "2026-10-22T11:59:00.000Z", undoneAt: null }, op])
        ?.id,
    ).toBe("c");
    expect(latestOp([])).toBeNull();
    const base = { createdAt: "t", updatedAt: "t", eventKinds: ["created"], children: 0, packets: 0, validations: 0, links: 1, copiedLinks: 1 };
    expect(isUntouched(base)).toBe(true);
    expect(isUntouched({ ...base, updatedAt: "t2" })).toBe(false);
    expect(isUntouched({ ...base, eventKinds: ["created", "link"] })).toBe(false);
    expect(isUntouched({ ...base, links: 2 })).toBe(false);
    expect(isUntouched({ ...base, children: 1 })).toBe(false);
    expect(isUntouched({ ...base, packets: 1 })).toBe(false);
    expect(isUntouched({ ...base, validations: 1 })).toBe(false);
    expect(isUntouched({ ...base, dependencies: 1 })).toBe(false);
    expect(isUntouched({ ...base, derived: 1 })).toBe(false);
  });

  it("undoes move, reorder and archive, and refuses stale or repeated undo", () => {
    const { u, area, project, v2, v3, v4 } = flagship();
    const kids = (pid: string) =>
      store
        .listItems(owner)
        .filter((i) => i.parentId === pid)
        .map((i) => i.title);
    const out: store.OpOut = {};
    store.moveItem(u, v3.id, area.id, cid, out);
    expect(out.op).toMatchObject({ kind: "move", label: "Moved" });
    const r = store.undoOp(u, out.op!.id, cid);
    expect(r).toMatchObject({ outcome: "restored", item: { parentId: project.id } });
    expect(kids(project.id)).toEqual(["V2 baseline", "V3 parity", "V4 lessons", "V5 evaluator contract"]);
    const lin = store.getDetail(owner, v3.id).lineage.filter((l) => l.relation === "moved_from");
    expect(lin.map((l) => [l.fromParentId, l.toParentId, l.note])).toEqual([
      [area.id, project.id, "Undo"],
      [project.id, area.id, null],
    ]);
    expect(store.getDetail(owner, v3.id).events[0]).toMatchObject({ kind: "undo", reason: "Undid move" });
    expect(() => store.undoOp(u, out.op!.id, cid)).toThrow(/Already undone/);

    // A later operation on the same item makes the earlier one unsafe to undo.
    const first: store.OpOut = {};
    store.placeItem(u, v4.id, { parentId: project.id, index: 0 }, cid, first);
    expect(first.op?.kind).toBe("reorder");
    const second: store.OpOut = {};
    store.reorderItem(u, v4.id, "down", second);
    expect(() => store.undoOp(u, first.op!.id, cid)).toThrow(/changed this item since/);
    store.undoOp(u, second.op!.id, cid);
    expect(kids(project.id)).toEqual(["V4 lessons", "V2 baseline", "V3 parity", "V5 evaluator contract"]);

    const arch: store.OpOut = {};
    store.updateItem(u, v2.id, { archived: true }, cid, arch);
    expect(arch.op?.kind).toBe("archive");
    expect(kids(project.id)).not.toContain("V2 baseline");
    store.undoOp(u, arch.op!.id, cid);
    expect(kids(project.id)).toContain("V2 baseline");
    // Too late.
    const late: store.OpOut = {};
    store.updateItem(u, v2.id, { archived: true }, cid, late);
    expect(() => store.undoOp(u, late.op!.id, cid, new Date(Date.now() + UNDO_WINDOW_MS + 1000))).toThrow(/Too late/);
    // Plain edits don't create undoable operations.
    const edit: store.OpOut = {};
    store.updateItem(u, v3.id, { title: "V3 parity check" }, cid, edit);
    expect(edit.op).toBeUndefined();
  });

  it("undoing a split/fork deletes the new item if untouched, otherwise archives it", async () => {
    const { u, v5 } = flagship();
    const s1: store.OpOut = {};
    const bug = store.splitItem(u, v5.id, { title: "Hydration perf bug" }, cid, s1);
    expect(store.undoOp(u, s1.op!.id, cid)).toMatchObject({ outcome: "deleted", item: null });
    expect(() => store.getDetail(owner, bug.id)).toThrow(/not found/);
    expect(store.getDetail(owner, v5.id).lineage).toEqual([]);
    expect(store.getDetail(owner, v5.id).events[0]).toMatchObject({ kind: "undo", reason: "Undid split: removed “Hydration perf bug”" });

    await store.addLink(u, v5.id, { kind: "url", url: "https://example.com/spec", role: "source" }, cid);
    const f1: store.OpOut = {};
    const fork = store.forkItem(u, v5.id, undefined, cid, f1);
    // A copied source link doesn't count as a change...
    const f2: store.OpOut = {};
    const fork2 = store.forkItem(u, v5.id, "Second fork", cid, f2);
    expect(store.undoOp(u, f2.op!.id, cid).outcome).toBe("deleted");
    // ...but an edit does: then undo archives instead of deleting.
    store.updateItem(u, fork.id, { summary: "Started exploring" }, cid);
    expect(store.undoOp(u, f1.op!.id, cid)).toMatchObject({ outcome: "archived", item: { archived: true } });
    expect(() => store.getDetail(owner, fork2.id)).toThrow(/not found/);
  });

  it("returns ops from routes and scopes undo to the owner", async () => {
    const { area, v5 } = flagship();
    const res = await call(moveRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { parentId: area.id } });
    const { op } = (await res.json()) as { op: { id: string; kind: string } };
    expect(op.kind).toBe("move");
    expect((await call(undoRoute.POST as H, { user: other, method: "POST", params: { id: op.id } })).status).toBe(404);
    expect((await call(undoRoute.POST as H, { user: kid, method: "POST", params: { id: op.id } })).status).toBe(403);
    expect((await call(undoRoute.POST as H, { method: "POST", params: { id: op.id }, csrf: false })).status).toBe(403);
    expect((await call(undoRoute.POST as H, { method: "POST", params: { id: op.id } })).status).toBe(200);
    expect((await call(undoRoute.POST as H, { method: "POST", params: { id: op.id } })).status).toBe(409);
  });
});

describe("timeline editing and dependencies", () => {
  it("snaps bar drags to days without crossing the other end (pure)", () => {
    const d = { startDate: "2026-10-05", targetDate: "2026-10-10" };
    expect(shiftDates(d, "move", 3)).toEqual({ startDate: "2026-10-08", targetDate: "2026-10-13" });
    expect(shiftDates(d, "move", -5.4)).toEqual({ startDate: "2026-09-30", targetDate: "2026-10-05" });
    expect(shiftDates(d, "start", 2)).toEqual({ startDate: "2026-10-07", targetDate: "2026-10-10" });
    expect(shiftDates(d, "start", 9)).toEqual({ startDate: "2026-10-10", targetDate: "2026-10-10" });
    expect(shiftDates(d, "end", -9)).toEqual({ startDate: "2026-10-05", targetDate: "2026-10-05" });
    expect(shiftDates(d, "end", 0.4)).toEqual(d);
    expect(shiftDates({ startDate: null, targetDate: "2026-12-31" }, "move", 1)).toEqual({ startDate: null, targetDate: "2027-01-01" });
    expect(shiftDates({ startDate: "2026-10-05", targetDate: null }, "end", 1)).toEqual({ startDate: "2026-10-06", targetDate: null });
  });

  it("refuses dependency loops (pure)", () => {
    const edges = [
      { itemId: "b", dependsOnId: "a" },
      { itemId: "c", dependsOnId: "b" },
    ];
    expect(wouldCreateDependencyCycle(edges, "a", "c")).toBe(true);
    expect(wouldCreateDependencyCycle(edges, "a", "a")).toBe(true);
    expect(wouldCreateDependencyCycle(edges, "c", "a")).toBe(false);
    expect(wouldCreateDependencyCycle(edges, "d", "c")).toBe(false);
    expect(
      wouldCreateDependencyCycle(
        [
          { itemId: "x", dependsOnId: "y" },
          { itemId: "y", dependsOnId: "x" },
        ],
        "z",
        "x",
      ),
    ).toBe(false);
  });

  it("stores dependencies, shows blocked-by, draws connectors and records date edits", () => {
    const { u, project, v2, v3, v4, v5 } = flagship();
    const dep = store.addDependency(u, v5.id, v4.id, cid);
    store.addDependency(u, v4.id, v3.id, cid);
    expect(() => store.addDependency(u, v3.id, v5.id, cid)).toThrow(/loop/);
    expect(() => store.addDependency(u, v5.id, v4.id, cid)).toThrow(/Already/);
    expect(() => store.addDependency(them(), v5.id, v2.id, cid)).toThrow(/not found/);
    let d = store.getDetail(owner, v5.id);
    expect(d.blockedBy).toEqual([{ dependencyId: dep.dependencyId, id: v4.id, title: "V4 lessons", status: "captured", open: true }]);
    expect(store.getDetail(owner, v4.id).blocking.map((b) => b.title)).toEqual(["V5 evaluator contract"]);
    expect(d.events[0]).toMatchObject({ kind: "dependency", reason: "Now depends on “V4 lessons”" });

    store.updateItem(u, v5.id, { startDate: "2026-10-05", targetDate: "2026-10-10" }, cid);
    d = store.getDetail(owner, v5.id);
    expect(d.events[0]).toMatchObject({ kind: "dates", reason: "Dates: start — → 2026-10-05, target — → 2026-10-10" });
    let t = store.timeline(owner, project.id);
    expect(t.dependencies.map((x) => [x.from, x.to])).toEqual(
      expect.arrayContaining([
        [v4.id, v5.id],
        [v3.id, v4.id],
      ]),
    );
    expect(t.rows.find((r) => r.id === v5.id)!.blocked).toBe(true);
    // A closed blocker no longer blocks.
    store.updateItem(u, v4.id, { status: "abandoned" }, cid);
    t = store.timeline(owner, project.id);
    expect(t.rows.find((r) => r.id === v5.id)!.blocked).toBe(false);
    expect(t.rows.find((r) => r.id === v4.id)!.blocked).toBe(true);
    store.removeDependency(u, dep.dependencyId, cid);
    expect(store.getDetail(owner, v5.id).blockedBy).toEqual([]);
    expect(() => store.removeDependency(u, dep.dependencyId, cid)).toThrow(/not found/);
  });

  it("a split child with a dependency is archived, not deleted, on undo", () => {
    const { u, v4, v5 } = flagship();
    const out: store.OpOut = {};
    const bug = store.splitItem(u, v5.id, { title: "Hydration perf bug" }, cid, out);
    store.addDependency(u, v4.id, bug.id, cid);
    expect(store.undoOp(u, out.op!.id, cid).outcome).toBe("archived");
  });

  it("checks dependencies at the API", async () => {
    const { v4, v5 } = flagship();
    expect((await call(depsRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { dependsOnId: v5.id } })).status).toBe(409);
    expect((await call(depsRoute.POST as H, { user: other, method: "POST", params: { id: v5.id }, body: { dependsOnId: v4.id } })).status).toBe(404);
    const ok = await call(depsRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { dependsOnId: v4.id } });
    expect(ok.status).toBe(200);
    const { dependency } = (await ok.json()) as { dependency: { dependencyId: string } };
    expect((await call(depRoute.DELETE as H, { user: other, method: "DELETE", params: { id: dependency.dependencyId } })).status).toBe(404);
    expect((await call(depRoute.DELETE as H, { method: "DELETE", params: { id: dependency.dependencyId } })).status).toBe(200);
  });
});

describe("validation templates and overdue", () => {
  it("detects overdue validations and applies templates (pure)", () => {
    expect(isValidationOverdue({ status: "pending", dueDate: "2026-10-21" }, "2026-10-22")).toBe(true);
    expect(isValidationOverdue({ status: "pending", dueDate: "2026-10-22" }, "2026-10-22")).toBe(false);
    expect(isValidationOverdue({ status: "fail", dueDate: "2026-10-01" }, "2026-10-22")).toBe(false);
    expect(isValidationOverdue({ status: "pending", dueDate: null }, "2026-10-22")).toBe(false);
    const t = { metric: "p95 hydration", comparator: "<=" as const, threshold: 800, unit: "ms", dueOffsetDays: 14 };
    expect(applyTemplate(t, "2026-12-25")).toEqual({
      metric: "p95 hydration",
      comparator: "<=",
      threshold: 800,
      unit: "ms",
      baseline: null,
      dueDate: "2027-01-08",
    });
    expect(applyTemplate({ ...t, dueOffsetDays: null }, "2026-12-25").dueDate).toBeNull();
    expect(applyTemplate({ ...t, dueOffsetDays: 0 }, "2026-12-25").dueDate).toBe("2026-12-25");
  });

  it("stores per-person templates, adds validations from them, and flags overdue ones everywhere", () => {
    const { u, area, project, v5 } = flagship();
    const today = localDate(Date.now(), config.timezone);
    expect(store.listTemplates(owner)).toEqual([]); // nothing seeded
    const t = store.createTemplate(u, { metric: "p95 hydration", comparator: "<=", threshold: 800, unit: "ms", dueOffsetDays: 7 }, cid);
    expect(t).toMatchObject({ name: "p95 hydration", dueOffsetDays: 7 });
    expect(store.listTemplates(other)).toEqual([]);
    const v = store.addValidationFromTemplate(u, v5.id, t.id, cid);
    expect(v).toMatchObject({
      metric: "p95 hydration",
      comparator: "<=",
      threshold: 800,
      unit: "ms",
      status: "pending",
      dueDate: addDays(today, 7),
      overdue: false,
    });
    expect(() => store.addValidationFromTemplate(them(), v5.id, t.id, cid)).toThrow(/not found/);
    expect(() => store.deleteTemplate(them(), t.id, cid)).toThrow(/not found/);

    // Make one overdue.
    const late = store.addValidation(u, v5.id, { metric: "error rate", comparator: "<", threshold: 1, unit: "%", dueDate: addDays(today, -2) }, cid);
    expect(late.overdue).toBe(true);
    expect(
      store
        .getDetail(owner, v5.id)
        .validations.filter((x) => x.overdue)
        .map((x) => x.metric),
    ).toEqual(["error rate"]);
    expect(store.timeline(owner, project.id).rows.find((r) => r.id === v5.id)!.validationOverdue).toBe(true);
    const dash = addWidget(u, { kind: "validation_overdue", config: { rootId: area.id } }, cid);
    const w = dash.widgets.find((x) => x.kind === "validation_overdue")!;
    expect(w.title).toBe("Validation overdue");
    expect(w.data).toMatchObject({ kind: "overdue", count: 1, items: [{ id: v5.id, detail: `1 overdue · error rate · due ${addDays(today, -2)}` }] });
    // Recording a value clears it.
    store.updateValidation(u, late.id, { observed: 0.5 }, cid);
    expect(getDashboard(owner).widgets.find((x) => x.kind === "validation_overdue")!.data).toMatchObject({ count: 0, items: [] });
    store.deleteTemplate(u, t.id, cid);
    expect(store.listTemplates(owner)).toEqual([]);
  });

  it("validates templates at the API", async () => {
    const { v5 } = flagship();
    expect((await call(templatesRoute.GET as H, { user: kid })).status).toBe(403);
    expect((await call(templatesRoute.POST as H, { method: "POST", body: { metric: "x", comparator: "~", threshold: 1 } })).status).toBe(400);
    expect((await call(templatesRoute.POST as H, { method: "POST", body: { metric: "x", comparator: "<", threshold: 1, dueOffsetDays: -1 } })).status).toBe(
      400,
    );
    const res = await call(templatesRoute.POST as H, { method: "POST", body: { metric: "x", comparator: "<", threshold: 1 } });
    const { template } = (await res.json()) as { template: { id: string } };
    expect((await call(fromTemplateRoute.POST as H, { user: other, method: "POST", params: { id: v5.id }, body: { templateId: template.id } })).status).toBe(
      404,
    );
    expect((await call(fromTemplateRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { templateId: template.id } })).status).toBe(200);
  });
});
