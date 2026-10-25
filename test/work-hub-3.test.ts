import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { areaValidationDefault, packetSchema } from "@/lib/work";
import * as store from "@/server/work/store";
import * as itemRoute from "@/app/api/work/items/[id]/route";
import * as packetsRoute from "@/app/api/work/items/[id]/packets/route";
import { recentAudit } from "@/server/audit";
import { createLocalSession } from "@/server/assistant/local";
import { unfiledConversations } from "@/server/work/conversations";
import {
  linkKey,
  parseAssignedIssues,
  parseWebhookEvent,
  pickConnection,
  pollDue,
  rateLimitBackoff,
  signBody,
  tokenWarnings,
  verifySignature,
  WEBHOOK_MAX_BYTES,
  WRITE_WARNING,
} from "@/server/work/github-rules";
import { __resetGithubBackoff, githubApiBase, resolveGithubToken } from "@/server/work/github";
import * as connections from "@/server/work/github-connections";
import { pollTick, pollerConfigured } from "@/server/work/github-poller";
import * as inbox from "@/server/work/inbox";
import { today } from "@/server/work/today";
import { addWidget, getDashboard } from "@/server/work/dashboard";
import * as githubRoute from "@/app/api/github/route";
import * as connectionsRoute from "@/app/api/github/connections/route";
import * as connectionRoute from "@/app/api/github/connections/[id]/route";
import * as connectionTestRoute from "@/app/api/github/connections/[id]/test/route";
import * as secretRoute from "@/app/api/github/webhook-secret/route";
import * as webhookRoute from "@/app/api/work/github/webhook/route";
import * as inboxRoute from "@/app/api/work/inbox/route";
import * as acceptRoute from "@/app/api/work/inbox/[id]/accept/route";
import * as dismissRoute from "@/app/api/work/inbox/[id]/dismiss/route";
import * as dismissConversationRoute from "@/app/api/work/inbox/conversations/dismiss/route";
import * as todayRoute from "@/app/api/work/today/route";

/** Work hub phase 3 (docs/work.md): owner decisions, GitHub connections, poller, webhooks, inbox. */

let owner: string, other: string, kid: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;

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

type H = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(
  handler: H,
  opts: { user?: string | null; method?: string; body?: unknown; csrf?: boolean; params?: Record<string, string>; query?: string; path?: string } = {},
) {
  const { user = owner, method = "GET", body, csrf = true, params = {}, query = "", path = "/api/work" } = opts;
  return handler(
    new NextRequest(`http://jarvis.test${path}${query}`, {
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

describe("validation default per area", () => {
  it("is optional for Miscellaneous and Home, required elsewhere, and an explicit setting wins", () => {
    expect(areaValidationDefault({ title: "Miscellaneous", systemKey: "misc" })).toBe("optional");
    expect(areaValidationDefault({ title: " home " })).toBe("optional");
    expect(areaValidationDefault({ title: "Household", systemKey: "home" })).toBe("optional");
    expect(areaValidationDefault({ title: "Momentum Bets" })).toBe("required");
    expect(areaValidationDefault({ title: "Home", validationDefault: "required" })).toBe("required");
    expect(areaValidationDefault({ title: "Momentum Bets", validationDefault: "optional" })).toBe("optional");
    expect(areaValidationDefault(null)).toBe("required");
  });

  it("new packets take the area default unless the form overrides it", () => {
    const u = me();
    const home = store.createItem(u, { kind: "area", title: "Home" }, cid);
    const hvac = store.createItem(u, { kind: "thread", title: "HVAC filter", parentId: home.id }, cid);
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    const loose = store.createItem(u, { kind: "thread", title: "Loose end" }, cid); // → Miscellaneous

    expect(store.getDetail(owner, hvac.id).validationDefault).toMatchObject({ value: "optional", explicit: false, areaTitle: "Home" });
    expect(store.getDetail(owner, v5.id).validationDefault).toMatchObject({ value: "required", areaTitle: "Momentum Bets" });
    expect(store.getDetail(owner, loose.id).validationDefault).toMatchObject({ value: "optional", areaTitle: "Miscellaneous" });

    const p = (o: object = {}) => packetSchema.parse({ objective: "Do it", nextAction: "Start", ...o });
    expect(store.createPacket(u, hvac.id, p(), cid)).toMatchObject({
      validationRequired: false,
      noValidationReason: "Validation is optional in Home (area default)",
    });
    expect(store.createPacket(u, v5.id, p(), cid)).toMatchObject({ validationRequired: true, noValidationReason: null });
    expect(store.createPacket(u, loose.id, p({ validationRequired: true }), cid)).toMatchObject({ validationRequired: true });
    expect(store.createPacket(u, v5.id, p({ validationRequired: false, noValidationReason: "Docs only" }), cid)).toMatchObject({
      validationRequired: false,
      noValidationReason: "Docs only",
    });
    // An explicit false still needs a reason (the form prefills one).
    expect(() => packetSchema.parse({ objective: "x", nextAction: "y", validationRequired: false })).toThrow();

    // Editable on the area; the item detail follows.
    store.updateItem(u, home.id, { validationDefault: "required" }, cid);
    expect(store.getDetail(owner, hvac.id).validationDefault).toMatchObject({ value: "required", explicit: true });
    expect(store.createPacket(u, hvac.id, p(), cid).validationRequired).toBe(true);
    store.updateItem(u, home.id, { validationDefault: null }, cid);
    expect(store.getDetail(owner, hvac.id).validationDefault).toMatchObject({ value: "optional", explicit: false });
    expect(() => store.updateItem(u, hvac.id, { validationDefault: "optional" }, cid)).toThrow(/area setting/);
  });

  it("is validated and owner-scoped at the API", async () => {
    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    expect((await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: mb.id }, body: { validationDefault: "maybe" } })).status).toBe(400);
    expect((await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: mb.id }, body: { validationDefault: "optional" } })).status).toBe(200);
    expect((await call(itemRoute.PATCH as H, { user: other, method: "PATCH", params: { id: mb.id }, body: { validationDefault: "required" } })).status).toBe(
      404,
    );
    const res = await call(packetsRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { objective: "x", nextAction: "y" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { packet: { validationRequired: boolean } }).packet.validationRequired).toBe(false);
  });
});

describe("auto-settle: never", () => {
  it("keeps legacy auto-settled rows readable", () => {
    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const old = store.createItem(u, { kind: "thread", title: "Old", parentId: mb.id }, cid);
    getDb()
      .update(schema.workItems)
      .set({ status: "settled", settledKind: "auto", settledReason: "PR #3 merged; no validation required" })
      .where(eq(schema.workItems.id, old.id))
      .run();
    expect(store.getDetail(owner, old.id).item).toMatchObject({ status: "settled", settledKind: "auto" });
    expect(kid).toBeTruthy();
  });
});

// --- GitHub ---

const TOKEN_A = "github_pat_synthetic_owner_a_token_value_0001";
const TOKEN_B = "github_pat_synthetic_owner_b_token_value_0002";
const CLASSIC = "ghp_synthetic_classic_value_0003";

type Call = { url: string; auth: string | null; method: string };
/** fetch stub: `routes` maps a path suffix to a response; records every call. */
function stubGithub(routes: Record<string, (url: string) => Response | Promise<Response>>, calls: Call[] = []) {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, auth: headers.get("authorization"), method: init.method ?? "GET" });
    const path = new URL(url).pathname + new URL(url).search;
    const hit = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.includes(k));
    return hit ? routes[hit]!(url) : Response.json({ message: "Not Found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function addConnection(o: { owner?: string; token?: string; repos?: string[]; label?: string } = {}) {
  return connections.createGithubConnection(
    me(),
    { label: o.label ?? "Test", owner: o.owner ?? "momentumbets", token: o.token ?? TOKEN_A, repos: o.repos ?? [] },
    cid,
  );
}

describe("GitHub rules (pure)", () => {
  it("picks the connection for the repo owner and respects its allowlist", () => {
    const conns = [
      { id: "a", ownerKey: "momentumbets", repos: [] },
      { id: "b", ownerKey: "nickbolles", repos: ["jarvis"] },
    ];
    expect(pickConnection(conns, "MomentumBets", "anything")?.id).toBe("a");
    expect(pickConnection(conns, "NickBolles", "Jarvis")?.id).toBe("b");
    expect(pickConnection(conns, "NickBolles", "other")).toBeNull();
    expect(pickConnection(conns, "someone", "x")).toBeNull();
  });

  it("warns loudly about classic and write-scoped tokens", () => {
    expect(tokenWarnings({ type: "fine_grained", scopes: null })).toEqual([]);
    expect(tokenWarnings({ type: "classic", scopes: ["read:org"] })).toContain(WRITE_WARNING);
    const w = tokenWarnings({ type: "classic", scopes: ["repo", "workflow"] });
    expect(w).toContain(WRITE_WARNING);
    expect(w.join(" ")).toMatch(/repo, workflow/);
    expect(tokenWarnings({ type: "other", scopes: ["admin:org"] })).toContain(WRITE_WARNING);
  });

  it("backs off on rate limits using retry-after / x-ratelimit-reset, exponential otherwise", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    const now = 1_700_000_000_000;
    expect(rateLimitBackoff({ status: 403, headers: h({}) }, now, 0)).toBeNull(); // plain forbidden
    expect(rateLimitBackoff({ status: 200, headers: h({ "x-ratelimit-remaining": "0" }) }, now, 0)).toBeNull();
    expect(rateLimitBackoff({ status: 429, headers: h({ "retry-after": "30" }) }, now, 0)).toEqual({ untilMs: now + 30_000, failures: 1 });
    const reset = Math.floor(now / 1000) + 600;
    expect(rateLimitBackoff({ status: 403, headers: h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }) }, now, 0)).toEqual({
      untilMs: reset * 1000 + 1000,
      failures: 1,
    });
    expect(rateLimitBackoff({ status: 429, headers: h({}) }, now, 0)!.untilMs).toBe(now + 60_000);
    expect(rateLimitBackoff({ status: 429, headers: h({}) }, now, 2)!.untilMs).toBe(now + 240_000);
    expect(rateLimitBackoff({ status: 429, headers: h({}) }, now, 20)!.untilMs).toBe(now + 60 * 60_000); // capped at 1 h
  });

  it("verifies X-Hub-Signature-256 in constant time and maps payloads", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = signBody("s3cret", body);
    expect(verifySignature("s3cret", body, sig)).toBe(true);
    expect(verifySignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature("s3cret", body, "sha1=abc")).toBe(false);
    expect(verifySignature("s3cret", body, null)).toBe(false);
    expect(verifySignature("", body, sig)).toBe(false);

    const repository = { full_name: "momentumbets/odds-feed" };
    expect(
      parseWebhookEvent("pull_request", { action: "closed", repository, pull_request: { number: 7, state: "closed", merged: true, title: "Fix" } }),
    ).toEqual({
      kind: "pull",
      owner: "momentumbets",
      repo: "odds-feed",
      number: 7,
      state: "merged",
      title: "Fix",
    });
    expect(parseWebhookEvent("pull_request", { repository, pull_request: { number: 8, state: "closed", merged: false } })).toMatchObject({ state: "closed" });
    expect(
      parseWebhookEvent("issues", {
        action: "assigned",
        repository,
        issue: {
          number: 3,
          state: "open",
          node_id: "I_1",
          title: "Stale odds",
          html_url: "https://github.com/momentumbets/odds-feed/issues/3",
          assignees: [{ login: "NickBolles" }],
        },
      }),
    ).toMatchObject({ kind: "issue", action: "assigned", nodeId: "I_1", assignees: ["nickbolles"] });
    expect(parseWebhookEvent("issues", { repository, issue: { number: 3, pull_request: {} } })).toBeNull();
    expect(parseWebhookEvent("push", { repository })).toBeNull();
    expect(linkKey({ owner: "MomentumBets", repo: "Odds", number: 1 })).toBe("momentumbets/odds#1");
  });

  it("parses assigned issues: open issues only, owner and allowlist, no PRs", () => {
    const mk = (n: number, full: string, extra: object = {}) => ({
      node_id: `I_${n}`,
      number: n,
      title: `Issue ${n}`,
      state: "open",
      html_url: `https://github.com/${full}/issues/${n}`,
      repository: { full_name: full },
      ...extra,
    });
    const body = [
      mk(1, "momentumbets/odds"),
      mk(2, "momentumbets/web"),
      mk(3, "other/odds"),
      mk(4, "momentumbets/odds", { pull_request: {} }),
      mk(5, "momentumbets/odds", { state: "closed" }),
    ];
    expect(parseAssignedIssues(body, { ownerKey: "momentumbets", repos: [] }).map((i) => i.number)).toEqual([1, 2]);
    expect(parseAssignedIssues(body, { ownerKey: "momentumbets", repos: ["odds"] }).map((i) => i.number)).toEqual([1]);
    expect(parseAssignedIssues({ not: "a list" }, { ownerKey: "x", repos: [] })).toEqual([]);
  });

  it("polls only when due and never when off", () => {
    expect(pollDue(null, 1000, 10)).toBe(true);
    expect(pollDue(0, 9 * 60_000, 10)).toBe(false);
    expect(pollDue(0, 10 * 60_000, 10)).toBe(true);
    expect(pollDue(null, 1000, 0)).toBe(false);
  });
});

describe("GitHub connections (admin settings)", () => {
  it("never returns or logs the token; CRUD is admin-only and audited", async () => {
    const created = await call(connectionsRoute.POST as H, {
      method: "POST",
      path: "/api/github/connections",
      body: { label: "Momentum", owner: "momentumbets", token: TOKEN_A, repos: ["odds-feed", "odds-feed", "web"] },
    });
    expect(created.status).toBe(200);
    const createdText = await created.text();
    expect(createdText).not.toContain(TOKEN_A);
    const { connection } = JSON.parse(createdText) as { connection: { id: string; tokenHint: string; repos: string[] } };
    expect(connection).toMatchObject({ tokenHint: "•••• 0001", repos: ["odds-feed", "web"] });

    const list = await call(githubRoute.GET as H, { path: "/api/github" });
    const listText = await list.text();
    expect(listText).not.toContain(TOKEN_A);
    expect(JSON.parse(listText)).toMatchObject({ connections: [{ owner: "momentumbets" }], webhook: { secretSet: false }, pollMinutes: 10 });

    // The stored value is encrypted.
    const row = getDb().select().from(schema.githubConnections).get()!;
    expect(row.tokenCipher).not.toContain(TOKEN_A);
    expect((await resolveGithubToken("momentumbets", "web"))?.token).toBe(TOKEN_A);

    // One connection per owner.
    expect((await call(connectionsRoute.POST as H, { method: "POST", body: { label: "Dup", owner: "MomentumBets", token: TOKEN_B } })).status).toBe(409);
    // Junk tokens and owners are refused.
    expect((await call(connectionsRoute.POST as H, { method: "POST", body: { label: "x", owner: "a/b", token: TOKEN_B } })).status).toBe(400);
    expect((await call(connectionsRoute.POST as H, { method: "POST", body: { label: "x", owner: "ab", token: "short" } })).status).toBe(400);

    const patched = await call(connectionRoute.PATCH as H, { method: "PATCH", params: { id: connection.id }, body: { token: TOKEN_B, label: "Momentum org" } });
    const patchedText = await patched.text();
    expect(patchedText).not.toContain(TOKEN_B);
    expect(JSON.parse(patchedText).connection).toMatchObject({ label: "Momentum org", tokenHint: "•••• 0002" });
    expect((await resolveGithubToken("momentumbets", "web"))?.token).toBe(TOKEN_B);

    // Not admin → 403 everywhere; signed out → 401.
    for (const u of [other, kid]) {
      expect((await call(githubRoute.GET as H, { user: u })).status).toBe(403);
      expect((await call(connectionsRoute.POST as H, { user: u, method: "POST", body: { label: "x", owner: "abc", token: TOKEN_A } })).status).toBe(403);
      expect((await call(connectionRoute.DELETE as H, { user: u, method: "DELETE", params: { id: connection.id } })).status).toBe(403);
    }
    expect((await call(githubRoute.GET as H, { user: null })).status).toBe(401);

    expect((await call(connectionRoute.DELETE as H, { method: "DELETE", params: { id: connection.id } })).status).toBe(200);
    expect(await resolveGithubToken("momentumbets", "web")).toBeNull();

    const audits = recentAudit(100).filter((a) => a.action.startsWith("github."));
    expect(audits.map((a) => a.action).sort()).toEqual(["github.connection_add", "github.connection_remove", "github.connection_update"]);
    const auditText = JSON.stringify(recentAudit(500));
    expect(auditText).not.toContain(TOKEN_A);
    expect(auditText).not.toContain(TOKEN_B);
  });

  it("Test reads /user and allowlisted repos, records scopes/permissions and warns about write access", async () => {
    vi.stubEnv("JARVIS_GITHUB_API_URL", "https://gh.mock/api/");
    expect(githubApiBase()).toBe("https://gh.mock/api");
    const fine = addConnection({ owner: "momentumbets", token: TOKEN_A, repos: ["odds-feed"] });
    const { calls } = stubGithub({
      "/api/user": () => Response.json({ login: "NickBolles" }),
      "/api/repos/momentumbets/odds-feed": () => Response.json({ full_name: "momentumbets/odds-feed", permissions: { admin: false, push: true, pull: true } }),
      "/api/orgs/nickbolles": () => Response.json({ message: "Not Found" }, { status: 404 }),
      "/api/users/nickbolles": () => Response.json({ login: "nickbolles" }),
      "/api/rate_limit": () => Response.json({ resources: { core: { limit: 5000, remaining: 4990 } } }),
    });
    const res = await call(connectionTestRoute.POST as H, { method: "POST", params: { id: fine.id } });
    const text = await res.text();
    expect(text).not.toContain(TOKEN_A);
    const r = JSON.parse(text);
    expect(r).toMatchObject({
      ok: true,
      login: "NickBolles",
      tokenType: "fine_grained",
      scopes: null,
      warnings: [],
      permissions: [{ repo: "odds-feed", push: true }],
    });
    expect(calls.every((c) => c.method === "GET" && c.url.startsWith("https://gh.mock/api/"))).toBe(true);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(connections.listGithubConnections()[0]).toMatchObject({ login: "NickBolles", lastTest: { ok: true } });

    // Classic token with write scopes, no allowlist: org (falls back to user) + rate limit, loud warning.
    const classic = addConnection({ owner: "nickbolles", token: CLASSIC });
    stubGithub({
      "/api/user": () => Response.json({ login: "NickBolles" }, { headers: { "x-oauth-scopes": "repo, workflow" } }),
      "/api/orgs/nickbolles": () => Response.json({ message: "Not Found" }, { status: 404 }),
      "/api/users/nickbolles": () => Response.json({ login: "nickbolles" }),
      "/api/rate_limit": () => Response.json({ resources: { core: { limit: 5000, remaining: 4990 } } }),
    });
    const c = await connections.testGithubConnection(me(), classic.id, cid);
    expect(c).toMatchObject({ ok: true, tokenType: "classic", scopes: ["repo", "workflow"] });
    expect(c.warnings).toContain(WRITE_WARNING);
    expect(c.checks.map((x) => x.name)).toEqual(["GET /user", "GET /orgs/nickbolles", "GET /rate_limit"]);

    // A refused token is a failed test, not a crash.
    stubGithub({ "/api/user": () => Response.json({ message: "Bad credentials" }, { status: 401 }) });
    const bad = await connections.testGithubConnection(me(), fine.id, cid);
    expect(bad.ok).toBe(false);
    expect(recentAudit(50).filter((a) => a.action === "github.connection_test")).toHaveLength(3);
    expect((await call(connectionTestRoute.POST as H, { user: other, method: "POST", params: { id: fine.id } })).status).toBe(403);
  });

  it("resolves tokens per owner with JARVIS_GITHUB_TOKEN as the fallback, and refresh uses them", async () => {
    addConnection({ owner: "momentumbets", token: TOKEN_A });
    addConnection({ owner: "NickBolles", token: TOKEN_B, repos: ["jarvis"] });
    expect(await resolveGithubToken("MOMENTUMBETS", "x")).toMatchObject({ token: TOKEN_A, source: "connection" });
    expect(await resolveGithubToken("nickbolles", "jarvis")).toMatchObject({ token: TOKEN_B });
    expect(await resolveGithubToken("nickbolles", "dotfiles")).toBeNull(); // outside the allowlist, no env
    vi.stubEnv("JARVIS_GITHUB_TOKEN", "synthetic-env-value");
    expect(await resolveGithubToken("nickbolles", "dotfiles")).toMatchObject({ token: "synthetic-env-value", source: "env" });
    expect(await resolveGithubToken("someone-else")).toMatchObject({ source: "env" });

    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/momentumbets/odds/pull/5" }, cid);
    await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/someone-else/x/pull/6", role: "reference" }, cid);
    const { calls } = stubGithub({ "/pulls/5": () => Response.json({ state: "closed", merged: true }), "/pulls/6": () => Response.json({ state: "open" }) });
    expect(await store.autoRefreshLinks(u, {}, cid)).toMatchObject({ checked: 2, changed: 1, errors: 0 });
    expect(calls.find((c) => c.url.endsWith("/pulls/5"))!.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(calls.find((c) => c.url.endsWith("/pulls/6"))!.auth).toBe("Bearer synthetic-env-value");
    expect(store.getDetail(owner, v5.id).item.status).toBe("awaiting_validation");
  });

  it("generates the webhook secret server-side and shows it only once", async () => {
    const first = await call(secretRoute.POST as H, { method: "POST" });
    const { secret } = (await first.json()) as { secret: string };
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(connections.webhookSecret()).toBe(secret);
    const settings = await (await call(githubRoute.GET as H)).text();
    expect(settings).not.toContain(secret);
    expect(JSON.parse(settings).webhook).toMatchObject({ secretSet: true, path: "/api/work/github/webhook" });
    const second = (await (await call(secretRoute.POST as H, { method: "POST" })).json()) as { secret: string };
    expect(second.secret).not.toBe(secret);
    expect(connections.webhookSecret()).toBe(second.secret);
    expect((await call(secretRoute.POST as H, { user: other, method: "POST" })).status).toBe(403);
    expect(JSON.stringify(recentAudit(50))).not.toContain(second.secret);
    // Poll interval: 0..1440, admin only.
    expect((await call(githubRoute.PATCH as H, { method: "PATCH", body: { pollMinutes: 0 } })).status).toBe(200);
    expect(connections.pollMinutes()).toBe(0);
    expect((await call(githubRoute.PATCH as H, { method: "PATCH", body: { pollMinutes: -1 } })).status).toBe(400);
    expect((await call(githubRoute.PATCH as H, { user: other, method: "PATCH", body: { pollMinutes: 5 } })).status).toBe(403);
  });
});

async function webhook(event: string, payload: unknown, o: { delivery?: string; secret?: string | null; sig?: string; raw?: string } = {}) {
  const body = o.raw ?? JSON.stringify(payload);
  const secret = o.secret === undefined ? connections.webhookSecret() : o.secret;
  return webhookRoute.POST(
    new NextRequest("http://jarvis.test/api/work/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": o.delivery ?? crypto.randomUUID(),
        ...(o.sig ? { "x-hub-signature-256": o.sig } : secret ? { "x-hub-signature-256": signBody(secret, body) } : {}),
      },
      body,
    }),
    { params: Promise.resolve({}) },
  );
}

describe("read-only GitHub webhook", () => {
  it("verifies the signature, dedupes deliveries and only updates linked PRs (exactly once)", async () => {
    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    const link = await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/MomentumBets/odds/pull/12" }, cid);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const payload = {
      action: "closed",
      repository: { full_name: "momentumbets/odds" },
      pull_request: { number: 12, state: "closed", merged: true, title: "Odds" },
    };

    // No secret configured yet: nothing is accepted.
    expect((await webhook("pull_request", payload, { secret: null, sig: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    connections.regenerateWebhookSecret(u, cid);
    expect((await webhook("pull_request", payload, { sig: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    expect((await webhook("pull_request", payload, { secret: "wrong-secret" })).status).toBe(401);
    expect(store.getDetail(owner, v5.id).item.status).toBe("captured");

    const res = await webhook("pull_request", payload, { delivery: "d-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ linked: 1, changed: 1 });
    let d = store.getDetail(owner, v5.id);
    expect(d.item.status).toBe("awaiting_validation");
    expect(d.links.find((l) => l.id === link.id)).toMatchObject({ externalState: "merged" });
    expect(d.events.filter((e) => e.kind === "status")).toHaveLength(1);
    expect(d.events.find((e) => e.kind === "status")).toMatchObject({ source: "github", actor: "github" });

    // Redelivery of the same id is a no-op; a new delivery with the same state is idempotent.
    expect(await (await webhook("pull_request", payload, { delivery: "d-1" })).json()).toMatchObject({ duplicate: true });
    expect(await (await webhook("pull_request", payload, { delivery: "d-2" })).json()).toMatchObject({ linked: 1, changed: 0 });
    d = store.getDetail(owner, v5.id);
    expect(d.events.filter((e) => e.kind === "status")).toHaveLength(1);

    // Unlinked PRs, other events and pings change nothing.
    expect(await (await webhook("pull_request", { ...payload, pull_request: { number: 99, state: "closed", merged: true } })).json()).toMatchObject({
      linked: 0,
      changed: 0,
    });
    expect((await webhook("push", { repository: { full_name: "momentumbets/odds" } })).status).toBe(202);
    expect((await webhook("ping", { zen: "hi" })).status).toBe(200);
    // Never calls GitHub.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses oversized and malformed deliveries", async () => {
    connections.regenerateWebhookSecret(me(), cid);
    const big = JSON.stringify({ pad: "x".repeat(WEBHOOK_MAX_BYTES) });
    expect((await webhook("pull_request", null, { raw: big })).status).toBe(413);
    expect((await webhook("pull_request", null, { raw: "{not json" })).status).toBe(400);
    const noDelivery = await webhookRoute.POST(
      new NextRequest("http://jarvis.test/api/work/github/webhook", {
        method: "POST",
        headers: { "x-github-event": "ping", "x-hub-signature-256": signBody(connections.webhookSecret()!, "{}") },
        body: "{}",
      }),
      { params: Promise.resolve({}) },
    );
    expect(noDelivery.status).toBe(400);
  });

  it("takes assigned issues into the inbox and removes them when unassigned", async () => {
    const conn = addConnection({ owner: "momentumbets", token: TOKEN_A });
    getDb().update(schema.githubConnections).set({ login: "NickBolles" }).where(eq(schema.githubConnections.id, conn.id)).run();
    connections.regenerateWebhookSecret(me(), cid);
    const issue = (assignees: string[], state = "open") => ({
      action: assignees.length ? "assigned" : "unassigned",
      repository: { full_name: "momentumbets/odds" },
      issue: {
        number: 31,
        state,
        node_id: "I_kw31",
        title: "Stale odds after reconnect",
        html_url: "https://github.com/momentumbets/odds/issues/31",
        assignees: assignees.map((login) => ({ login })),
      },
    });
    expect(await (await webhook("issues", issue(["nickbolles"]))).json()).toMatchObject({ intake: 1 });
    expect(inbox.inboxEntries(owner)).toMatchObject([{ source: "github_issue", title: "Stale odds after reconnect", repo: "momentumbets/odds", number: 31 }]);
    await webhook("issues", issue(["nickbolles"])); // dedupe by node id
    expect(inbox.inboxEntries(owner)).toHaveLength(1);
    expect(inbox.inboxEntries(other)).toHaveLength(0);
    await webhook("issues", issue([]));
    expect(inbox.inboxEntries(owner)).toHaveLength(0);
    await webhook("issues", issue(["someone"]));
    expect(inbox.inboxEntries(owner)).toHaveLength(0);
  });
});

describe("Work GitHub poller", () => {
  it("is off without a connection or with 0 minutes", () => {
    expect(pollerConfigured()).toBe(false);
    addConnection();
    expect(pollerConfigured()).toBe(true);
    connections.setPollMinutes(me(), 0, cid);
    expect(pollerConfigured()).toBe(false);
  });

  it("reads at most 50 links per tick with 4 in flight, throttles per link and applies merges once", async () => {
    __resetGithubBackoff();
    addConnection({ owner: "momentumbets", token: TOKEN_A });
    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/momentumbets/odds/pull/1000" }, cid);
    for (let n = 1; n <= 59; n++)
      await store.addLink(u, mb.id, { kind: "github_pr", url: `https://github.com/momentumbets/odds/pull/${n}`, role: "reference" }, cid);
    let inFlight = 0;
    let peak = 0;
    const { calls } = stubGithub({
      "/pulls/": async (url) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight--;
        return url.endsWith("/pulls/1000") ? Response.json({ state: "closed", merged: true }) : Response.json({ state: "open" });
      },
      "/issues?filter=assigned": () => Response.json([]),
    });
    const t0 = new Date();
    const first = await pollTick(t0);
    expect(first.links.checked).toBe(50);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    const second = await pollTick(t0);
    expect(second.links.checked).toBe(10);
    expect((await pollTick(t0)).links.checked).toBe(0); // per-link minimum interval
    expect(calls.filter((c) => c.url.includes("/pulls/")).length).toBe(60);
    expect(store.getDetail(owner, v5.id).item.status).toBe("awaiting_validation");
    const later = new Date(t0.getTime() + 6 * 60_000);
    await pollTick(later);
    expect(store.getDetail(owner, v5.id).events.filter((e) => e.kind === "status")).toHaveLength(1);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("backs off a token after 429 and syncs assigned issues into the inbox, deduped, dismiss remembered", async () => {
    __resetGithubBackoff();
    const conn = addConnection({ owner: "momentumbets", token: TOKEN_A });
    const issues = [
      {
        node_id: "I_a",
        number: 1,
        title: "Assigned A",
        state: "open",
        html_url: "https://github.com/momentumbets/odds/issues/1",
        repository: { full_name: "momentumbets/odds" },
      },
      {
        node_id: "I_b",
        number: 2,
        title: "Assigned B",
        state: "open",
        html_url: "https://github.com/momentumbets/odds/issues/2",
        repository: { full_name: "momentumbets/odds" },
      },
    ];
    let list = issues;
    let limited = true;
    const { calls } = stubGithub({
      "/issues?filter=assigned": () =>
        limited ? Response.json({ message: "rate limited" }, { status: 429, headers: { "retry-after": "120" } }) : Response.json(list),
    });
    const t0 = new Date();
    expect((await pollTick(t0)).issues).toMatchObject({ connections: 1, errors: 1 });
    limited = false;
    // Still backing off: no request at all.
    expect((await pollTick(new Date(t0.getTime() + 60_000))).issues).toMatchObject({ skipped: 1 });
    expect(calls).toHaveLength(1);
    __resetGithubBackoff();
    expect((await pollTick(new Date(t0.getTime() + 180_000))).issues).toMatchObject({ synced: 2 });
    await pollTick(new Date(t0.getTime() + 240_000));
    expect(
      inbox
        .inboxEntries(owner)
        .map((e) => e.title)
        .sort(),
    ).toEqual(["Assigned A", "Assigned B"]);
    expect(inbox.inboxEntries(owner)[0]!.reason).toMatch(/Assigned to you on GitHub/);

    const b = inbox.inboxEntries(owner).find((e) => e.title === "Assigned B")!;
    inbox.dismissEntry(me(), b.id, cid);
    await pollTick(new Date(t0.getTime() + 300_000));
    expect(inbox.inboxEntries(owner).map((e) => e.title)).toEqual(["Assigned A"]); // dismissal is remembered
    list = []; // closed/unassigned on GitHub → leaves the inbox
    await pollTick(new Date(t0.getTime() + 360_000));
    expect(inbox.inboxEntries(owner)).toEqual([]);
    expect(conn.id).toBeTruthy();
  });
});

describe("Work inbox and Today", () => {
  it("captures, accepts into Miscellaneous by default (linking the issue) and dismisses", async () => {
    const u = me();
    const conn = addConnection({ owner: "momentumbets", token: TOKEN_A });
    inbox.syncAssignedIssues({ id: conn.id, createdBy: owner, owner: "momentumbets" }, [
      {
        nodeId: "I_z",
        title: "Bet slip stale odds",
        url: "https://github.com/momentumbets/odds/issues/231",
        repo: "momentumbets/odds",
        owner: "momentumbets",
        number: 231,
      },
    ]);
    const cap = await call(inboxRoute.POST as H, { method: "POST", body: { text: "Call the HVAC company\nAsk about filters" } });
    expect(cap.status).toBe(200);
    expect((await cap.json()).entry).toMatchObject({ source: "capture", title: "Call the HVAC company", note: "Ask about filters" });
    expect((await call(inboxRoute.POST as H, { method: "POST", body: { text: "  " } })).status).toBe(400);

    const list = (await (await call(inboxRoute.GET as H)).json()) as { items: { id: string; source: string; title: string }[]; count: number };
    expect(list.items.map((i) => i.source).sort()).toEqual(["capture", "github_issue"]);
    const issue = list.items.find((i) => i.source === "github_issue")!;
    const capture = list.items.find((i) => i.source === "capture")!;

    // Someone else can't see or act on them; kids have no Work at all.
    expect((await call(acceptRoute.POST as H, { user: other, method: "POST", params: { id: issue.id }, body: { parentId: null } })).status).toBe(404);
    expect((await call(dismissRoute.POST as H, { user: kid, method: "POST", params: { id: issue.id } })).status).toBe(403);

    const accepted = await call(acceptRoute.POST as H, { method: "POST", params: { id: issue.id }, body: { parentId: null, role: "implementation" } });
    expect(accepted.status).toBe(200);
    const { item } = (await accepted.json()) as { item: { id: string; parentId: string } };
    const d = store.getDetail(owner, item.id);
    expect(d.breadcrumb.map((b) => b.title)).toEqual(["Miscellaneous"]);
    expect(d.links).toMatchObject([{ kind: "github_issue", role: "implementation", url: "https://github.com/momentumbets/odds/issues/231" }]);
    expect((await call(acceptRoute.POST as H, { method: "POST", params: { id: issue.id }, body: { parentId: null } })).status).toBe(409);
    // Re-syncing the same issue doesn't bring it back.
    inbox.syncAssignedIssues({ id: conn.id, createdBy: owner, owner: "momentumbets" }, [
      {
        nodeId: "I_z",
        title: "Bet slip stale odds",
        url: "https://github.com/momentumbets/odds/issues/231",
        repo: "momentumbets/odds",
        owner: "momentumbets",
        number: 231,
      },
    ]);
    expect(inbox.inboxEntries(owner).map((e) => e.id)).toEqual([capture.id]);

    const home = store.createItem(u, { kind: "area", title: "Home" }, cid);
    expect((await call(acceptRoute.POST as H, { method: "POST", params: { id: capture.id }, body: { parentId: home.id } })).status).toBe(200);
    expect(store.listItems(owner).find((i) => i.title === "Call the HVAC company")).toMatchObject({ parentId: home.id, summary: "Ask about filters" });

    const c2 = inbox.capture(u, { text: "Throwaway" }, cid);
    expect((await call(dismissRoute.POST as H, { method: "POST", params: { id: c2.id } })).status).toBe(200);
    expect(inbox.inboxEntries(owner)).toEqual([]);
    const actions = recentAudit(100).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["work.inbox_capture", "work.inbox_accept", "work.inbox_dismiss"]));
  });

  it("lists unfiled conversations in the inbox and remembers dismissals by id only", async () => {
    const u = me();
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
    const a = createLocalSession(u, "Enable v5 rollout");
    createLocalSession(u, "Morning planning");
    const before = (await (await call(inboxRoute.GET as H)).json()) as { conversations: { id: string }[]; count: number };
    expect(before.conversations.map((c) => c.id)).toContain(a.id);
    expect(before.count).toBe(2);
    expect((await call(dismissConversationRoute.POST as H, { method: "POST", body: { sessionId: a.id } })).status).toBe(200);
    expect((await unfiledConversations(u)).conversations.map((c) => c.id)).not.toContain(a.id);
    const row = getDb().select().from(schema.workInbox).where(eq(schema.workInbox.externalId, a.id)).get()!;
    expect(row).toMatchObject({ source: "conversation", title: "", note: "" }); // Hermes owns the content
  });

  it("Today: KPIs, continue, proof due, ready to settle", async () => {
    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    const hy = store.createItem(u, { kind: "thread", title: "Hydration", parentId: mb.id }, cid);
    const docs = store.createItem(u, { kind: "thread", title: "Docs", parentId: mb.id }, cid);
    store.createPacket(u, v5.id, packetSchema.parse({ objective: "x", nextAction: "Wire rubric" }), cid);
    store.createPacket(u, hy.id, packetSchema.parse({ objective: "x", nextAction: "Measure" }), cid);
    store.addValidation(u, hy.id, { metric: "p95", comparator: "<=", threshold: 1.2, unit: "s", dueDate: "2020-01-01" }, cid);
    const pr = await store.addLink(u, hy.id, { kind: "github_pr", url: "https://github.com/o/r/pull/1" }, cid);
    store.setLinkState(u, pr.id, "merged", cid);
    store.createPacket(u, docs.id, packetSchema.parse({ objective: "x", nextAction: "Merge", validationRequired: false, noValidationReason: "Docs" }), cid);
    const pr2 = await store.addLink(u, docs.id, { kind: "github_pr", url: "https://github.com/o/r/pull/2" }, cid);
    store.setLinkState(u, pr2.id, "merged", cid);

    const t = today(owner);
    expect(t.kpis).toEqual({ inProgress: 1, awaitingValidation: 1, overdue: 1, mergedNotSettled: 2 });
    expect(t.continue.map((c) => c.title)).toEqual(["V5"]);
    expect(t.continue[0]).toMatchObject({ path: "Momentum Bets", nextAction: "Wire rubric" });
    expect(t.proofDue).toMatchObject([{ title: "Hydration", due: "2020-01-01", detail: "p95 <= 1.2 s" }]);
    expect(t.readyToSettle).toMatchObject([{ title: "Docs", detail: "PR merged — settle?" }]);
    expect((await call(todayRoute.GET as H)).status).toBe(200);
    expect((await call(todayRoute.GET as H, { user: kid })).status).toBe(403);
    expect(today(other).kpis).toEqual({ inProgress: 0, awaitingValidation: 0, overdue: 0, mergedNotSettled: 0 });

    // Command Center dashboard widgets: Pulse (KPIs) and Status lanes (overview/filter, scoped like the others).
    const pulse = addWidget(u, { kind: "kpis" }, cid).widgets.at(-1)!;
    const lanes = addWidget(u, { kind: "status_lanes", config: { rootId: mb.id } }, cid).widgets.at(-1)!;
    expect([pulse.size, lanes.size]).toEqual(["lg", "lg"]);
    const d = getDashboard(owner);
    expect(d.widgets.find((w) => w.id === pulse.id)!.data).toMatchObject({ kind: "kpis", inProgress: 1, awaitingValidation: 1, readyToSettle: 1, overdue: 1 });
    const l = d.widgets.find((w) => w.id === lanes.id)!.data as { kind: "lanes"; lanes: { status: string; count: number; items: { title: string }[] }[] };
    expect(l.lanes.map((x) => x.status)).toEqual(["exploring", "ready", "in_progress", "in_review", "awaiting_validation", "ready_to_settle", "settled"]);
    expect(l.lanes.find((x) => x.status === "ready_to_settle")).toMatchObject({ count: 1, items: [{ title: "Docs" }] });
    expect(l.lanes.find((x) => x.status === "in_progress")!.items.map((i) => i.title)).toEqual(["V5"]);
  });
});
