import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { createLocalSession } from "@/server/assistant/local";
import { filingTokens, handoffMarkdown, packetSchema, suggestFiling } from "@/lib/work";
import { getSessionDetail } from "@/server/assistant";
import { recentAudit } from "@/server/audit";
import * as continueRoute from "@/app/api/work/items/[id]/continue/route";
import * as ghRefreshRoute from "@/app/api/work/github/refresh/route";
import { dueForRefresh, REFRESH_INTERVAL_MS } from "@/server/work/refresh-rules";
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
