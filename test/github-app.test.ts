import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { recentAudit } from "@/server/audit";
import * as store from "@/server/work/store";
import * as connections from "@/server/work/github-connections";
import * as ghApp from "@/server/work/github-app";
import { resolveGithubToken, __resetGithubBackoff } from "@/server/work/github";
import {
  accountAllowed,
  appJwt,
  buildManifest,
  combineChecks,
  defaultAllowlist,
  defaultAppName,
  manifestAction,
  parseChecksEvent,
  parseInstallationEvent,
  pickInstallation,
  STATE_TTL_MS,
  stateProblem,
  tokenFresh,
  TOKEN_REFRESH_MARGIN_MS,
  verifyJwt,
} from "@/server/work/github-app-rules";
import { signBody } from "@/server/work/github-rules";
import * as githubRoute from "@/app/api/github/route";
import * as appRoute from "@/app/api/github/app/route";
import * as manifestRoute from "@/app/api/github/app/manifest/route";
import * as callbackRoute from "@/app/api/github/app/callback/route";
import * as refreshRoute from "@/app/api/github/app/installations/refresh/route";
import * as connectRoute from "@/app/api/github/app/connect/route";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as webhookRoute from "@/app/api/work/github/webhook/route";

/** GitHub App manifest flow + installations (docs/work.md "GitHub App"). */

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const CLIENT_SECRET = "synthetic-client-secret-" + "a1b2c3d4e5";
const APP_HOOK_SECRET = "synthetic-app-hook-secret-" + "f6g7h8";
const PAT = "github_pat_" + "synthetic_app_suite_value_0009";
const cid = "test-correlation";

let owner: string, other: string, ownerCookie: string;
const me = () => resolveUser(new Headers(), createSession(owner).token)!;

beforeEach(() => {
  __setTestDatabase();
  ghApp.__resetAppTokenCache();
  __resetGithubBackoff();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  ownerCookie = createSession(owner).token;
  vi.stubEnv("JARVIS_GITHUB_API_URL", "https://gh.mock/api");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type H = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: H, o: { cookie?: string | null; method?: string; body?: unknown; path?: string; host?: string } = {}) {
  const { cookie = ownerCookie, method = "GET", body, path = "/api/github", host = "jarvis.example.com" } = o;
  return handler(
    new NextRequest(`https://${host}${path}`, {
      method,
      headers: {
        host,
        "x-forwarded-proto": "https",
        ...(cookie ? { cookie: `jarvis_session=${cookie}` } : {}),
        "x-jarvis-csrf": "1",
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({}) },
  );
}

type Call = { url: string; method: string; auth: string | null };
function stubFetch(routes: Record<string, (url: string, init: RequestInit) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization") });
    const u = new URL(url);
    const path = `${init.method ?? "GET"} ${u.pathname}${u.search}`;
    const hit = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.includes(k));
    return hit ? routes[hit]!(url, init) : Response.json({ message: "Not Found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const conversion = (o: Record<string, unknown> = {}) => ({
  id: 4242,
  slug: "jarvis-example",
  name: "Jarvis (jarvis.example.com)",
  owner: { login: "NickBolles", type: "User" },
  html_url: "https://github.com/apps/jarvis-example",
  client_id: "Iv1.synthetic",
  client_secret: CLIENT_SECRET,
  webhook_secret: APP_HOOK_SECRET,
  pem: PEM,
  ...o,
});

/** Run the whole manifest flow against the stubbed conversion endpoint. */
async function createApp(o: Record<string, unknown> = {}) {
  const start = await call(manifestRoute.POST as H, {
    method: "POST",
    path: "/api/github/app/manifest",
    body: { name: "Jarvis (jarvis.example.com)", target: "user" },
  });
  expect(start.status).toBe(200);
  const { action } = (await start.json()) as { action: string };
  const state = new URL(action).searchParams.get("state")!;
  stubFetch({ "POST /api/app-manifests/code123/conversions": () => Response.json(conversion(o), { status: 201 }) });
  const res = await call(callbackRoute.GET as H, { path: `/api/github/app/callback?code=code123&state=${encodeURIComponent(state)}` });
  return res;
}

/** Stubs for the App JWT endpoints; checks every JWT like GitHub would. */
function stubAppApi(installations: { id: number; account: string; type?: string; selection?: string; repos?: string[]; suspended?: boolean }[]) {
  const minted: string[] = [];
  const jwtOk = (init: RequestInit) => {
    const token = new Headers(init.headers).get("authorization")!.slice(7);
    const claims = verifyJwt(token, publicKey);
    return !!claims && claims.iss === "4242";
  };
  const routes: Record<string, (url: string, init: RequestInit) => Response> = {
    "GET /api/app/installations": (_u, init) =>
      jwtOk(init)
        ? Response.json(
            installations.map((i) => ({
              id: i.id,
              account: { login: i.account, type: i.type ?? "User" },
              repository_selection: i.selection ?? "selected",
              suspended_at: i.suspended ? "2026-10-01T00:00:00Z" : null,
            })),
          )
        : Response.json({ message: "bad jwt" }, { status: 401 }),
    "GET /api/installation/repositories": (_u, init) => {
      const token = new Headers(init.headers).get("authorization")!.slice(7);
      const inst = installations.find((i) => token.startsWith(`inst_${i.id}_`));
      return inst ? Response.json({ repositories: (inst.repos ?? []).map((name) => ({ name })) }) : Response.json({}, { status: 401 });
    },
  };
  for (const i of installations)
    routes[`POST /api/app/installations/${i.id}/access_tokens`] = (_u, init) => {
      if (!jwtOk(init)) return Response.json({ message: "bad jwt" }, { status: 401 });
      const t = `inst_${i.id}_${minted.length}`;
      minted.push(t);
      return Response.json({ token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    };
  return { ...stubFetch(routes), minted };
}

function secretsIn(text: string) {
  return [CLIENT_SECRET, APP_HOOK_SECRET, "PRIVATE KEY", PEM.split("\n")[1]!, PAT].filter((s) => text.includes(s));
}

describe("GitHub App rules (pure)", () => {
  it("signs an RS256 JWT with iat-60s, exp 9 min, iss = App id", () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    const jwt = appJwt(4242, PEM, now);
    const [h] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = verifyJwt(jwt, publicKey)!;
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "4242" });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
    // Tampering or another key fails.
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(verifyJwt(jwt, other)).toBeNull();
    expect(verifyJwt(jwt.replace(/\.[^.]+\./, `.${Buffer.from('{"iss":"1"}').toString("base64url")}.`), publicKey)).toBeNull();
  });

  it("builds the read-only manifest and posts it to the user or org page", () => {
    const m = buildManifest("https://jarvis.example.com", "Jarvis (jarvis.example.com)");
    expect(m).toMatchObject({
      name: "Jarvis (jarvis.example.com)",
      url: "https://jarvis.example.com",
      public: true,
      redirect_url: "https://jarvis.example.com/api/github/app/callback",
      hook_attributes: { url: "https://jarvis.example.com/api/work/github/webhook", active: true },
      default_events: ["pull_request", "pull_request_review", "issues", "check_suite", "workflow_run"],
    });
    expect(Object.values(m.default_permissions).every((p) => p === "read")).toBe(true);
    expect(Object.keys(m.default_permissions).sort()).toEqual(["actions", "checks", "issues", "metadata", "pull_requests", "statuses"]);
    expect(manifestAction("user", undefined, "s1")).toBe("https://github.com/settings/apps/new?state=s1");
    expect(manifestAction("org", "momentumbets", "s/2")).toBe("https://github.com/organizations/momentumbets/settings/apps/new?state=s%2F2");
    expect(defaultAppName("https://jarvis.example.com")).toBe("Jarvis (jarvis.example.com)");
    expect(defaultAppName("https://a-very-long-hostname.subdomain.example.com").length).toBeLessThanOrEqual(34);
  });

  it("refuses unknown, expired, other-user and other-session states", () => {
    const now = Date.now();
    const row = { userId: "u1", sessionKey: "k1", expiresAt: new Date(now + STATE_TTL_MS).toISOString() };
    expect(stateProblem(row, { userId: "u1", sessionKey: "k1" }, now)).toBeNull();
    expect(stateProblem(null, { userId: "u1", sessionKey: "k1" }, now)).toBe("unknown");
    expect(stateProblem(row, { userId: "u1", sessionKey: "k1" }, now + STATE_TTL_MS + 1)).toBe("expired");
    expect(stateProblem(row, { userId: "u2", sessionKey: "k1" }, now)).toBe("other_user");
    expect(stateProblem(row, { userId: "u1", sessionKey: "k2" }, now)).toBe("other_session");
  });

  it("keeps installation tokens until 5 minutes before expiry", () => {
    const now = 1_000_000;
    expect(tokenFresh(null, now)).toBe(false);
    expect(tokenFresh({ expiresAtMs: now + TOKEN_REFRESH_MARGIN_MS + 1 }, now)).toBe(true);
    expect(tokenFresh({ expiresAtMs: now + TOKEN_REFRESH_MARGIN_MS }, now)).toBe(false);
  });

  it("allowlist defaults to token owners + App owner; installations must be allowlisted and cover the repo", () => {
    const list = defaultAllowlist(["MomentumBets", "nickbolles"], "NickBolles");
    expect(list).toEqual(["momentumbets", "nickbolles"]);
    expect(accountAllowed(list, "MOMENTUMBETS")).toBe(true);
    expect(accountAllowed(list, "evil-corp")).toBe(false);
    const insts = [
      { id: 1, accountKey: "momentumbets", repositorySelection: "selected", repos: ["odds"], suspended: false },
      { id: 2, accountKey: "nickbolles", repositorySelection: "all", repos: [], suspended: false },
      { id: 3, accountKey: "evil-corp", repositorySelection: "all", repos: [], suspended: false },
      { id: 4, accountKey: "paused", repositorySelection: "all", repos: [], suspended: true },
    ];
    expect(pickInstallation(insts, list, "momentumbets", "ODDS")?.id).toBe(1);
    expect(pickInstallation(insts, list, "momentumbets", "web")).toBeNull();
    expect(pickInstallation(insts, list, "NickBolles", "anything")?.id).toBe(2);
    expect(pickInstallation(insts, list, "evil-corp", "x")).toBeNull();
    expect(pickInstallation(insts, [...list, "paused"], "paused", "x")).toBeNull();
  });

  it("combines check suites and commit statuses into green / red / running", () => {
    const done = (conclusion: string) => ({ status: "completed", conclusion, latest_check_runs_count: 2 });
    expect(combineChecks([done("success"), done("skipped")], { state: "pending", total_count: 0 })).toBe("success");
    expect(combineChecks([done("success"), done("failure")], null)).toBe("failure");
    expect(combineChecks([done("success")], { state: "error", total_count: 1 })).toBe("failure");
    expect(combineChecks([done("success"), { status: "in_progress", conclusion: null, latest_check_runs_count: 1 }], null)).toBe("pending");
    // Suites with no runs (apps that never ran) don't hold things up.
    expect(combineChecks([done("success"), { status: "queued", conclusion: null, latest_check_runs_count: 0 }], null)).toBe("success");
    expect(combineChecks([], { state: "success", total_count: 3 })).toBe("success");
    expect(combineChecks([], { state: "pending", total_count: 0 })).toBeNull();
  });

  it("parses installation and check webhooks", () => {
    expect(
      parseInstallationEvent("installation", {
        action: "created",
        installation: { id: 7, account: { login: "momentumbets", type: "Organization" }, repository_selection: "selected" },
        repositories: [{ name: "odds", full_name: "momentumbets/odds" }],
      }),
    ).toMatchObject({ id: 7, account: "momentumbets", accountType: "Organization", repos: ["odds"], suspended: false });
    expect(
      parseInstallationEvent("installation_repositories", {
        action: "added",
        installation: { id: 7, account: { login: "momentumbets" } },
        repository_selection: "selected",
        repositories_added: [{ full_name: "momentumbets/web" }],
        repositories_removed: [],
      }),
    ).toMatchObject({ repos: null, added: ["web"] });
    expect(parseInstallationEvent("installation", { action: "created" })).toBeNull();
    expect(
      parseChecksEvent("check_suite", {
        repository: { full_name: "momentumbets/odds" },
        check_suite: { head_sha: "abc1234", status: "completed", conclusion: "failure", pull_requests: [{ number: 3 }, { number: 3 }] },
      }),
    ).toEqual({ kind: "checks", owner: "momentumbets", repo: "odds", sha: "abc1234", prNumbers: [3], state: "failure" });
    expect(parseChecksEvent("workflow_run", { repository: { full_name: "a/b" }, workflow_run: { status: "in_progress", pull_requests: [] } })).toMatchObject({
      state: "pending",
    });
  });
});

describe("manifest flow (API)", () => {
  it("is admin-only; returns the manifest + a one-time state bound to the session", async () => {
    expect((await call(manifestRoute.POST as H, { cookie: createSession(other).token, method: "POST", body: { name: "J", target: "user" } })).status).toBe(403);
    expect((await call(manifestRoute.POST as H, { cookie: null, method: "POST", body: { name: "J", target: "user" } })).status).toBe(401);
    expect((await call(manifestRoute.POST as H, { method: "POST", body: { name: "x".repeat(35), target: "user" } })).status).toBe(400);
    expect((await call(manifestRoute.POST as H, { method: "POST", body: { name: "J", target: "org" } })).status).toBe(400);

    const res = await call(manifestRoute.POST as H, { method: "POST", body: { name: "Jarvis (home)", target: "org", org: "momentumbets" } });
    const { action, manifest } = (await res.json()) as { action: string; manifest: string };
    expect(action).toMatch(/^https:\/\/github\.com\/organizations\/momentumbets\/settings\/apps\/new\?state=[\w-]{40,}$/);
    expect(JSON.parse(manifest)).toMatchObject({
      name: "Jarvis (home)",
      url: "https://jarvis.example.com",
      redirect_url: "https://jarvis.example.com/api/github/app/callback",
      hook_attributes: { url: "https://jarvis.example.com/api/work/github/webhook" },
    });
    // Only a hash of the state is stored.
    const state = new URL(action).searchParams.get("state")!;
    const rows = getDb().select().from(schema.githubAppStates).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(state);
    expect(recentAudit(10).find((a) => a.action === "github.app_manifest")).toBeTruthy();
  });

  it("callback: exchanges the code, stores credentials encrypted, never returns or logs them", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const res = await createApp();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/connections?github_app=created#github");
    expect(await res.text()).toBe("");
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("https://gh.mock/api/app-manifests/code123/conversions");
    expect(calls[0]![1].method).toBe("POST");

    const row = getDb().select().from(schema.githubApps).get()!;
    expect(row).toMatchObject({ appId: 4242, slug: "jarvis-example", ownerLogin: "NickBolles", clientId: "Iv1.synthetic" });
    expect(secretsIn(JSON.stringify(row))).toEqual([]);
    expect(ghApp.appWebhookSecret()).toBe(APP_HOOK_SECRET);
    // The state was used up.
    expect(getDb().select().from(schema.githubAppStates).all()).toHaveLength(0);

    const settings = await (await call(githubRoute.GET as H)).text();
    expect(secretsIn(settings)).toEqual([]);
    expect(JSON.parse(settings).app).toMatchObject({
      appId: 4242,
      slug: "jarvis-example",
      installUrl: "https://github.com/apps/jarvis-example/installations/new",
      webhookSecretSet: true,
      allowlist: ["nickbolles"],
      allowlistIsDefault: true,
    });
    expect(JSON.parse(settings).appSetup).toMatchObject({ defaultName: "Jarvis (jarvis.example.com)", https: true });
    expect(secretsIn(JSON.stringify(recentAudit(500)))).toEqual([]);
    for (const spy of logs) expect(secretsIn(JSON.stringify(spy.mock.calls))).toEqual([]);

    // One App at a time.
    expect((await call(manifestRoute.POST as H, { method: "POST", body: { name: "Again", target: "user" } })).status).toBe(409);
  });

  it("callback refuses a reused, foreign-session, expired or non-admin state without calling GitHub", async () => {
    const start = async (cookie = ownerCookie) => {
      const r = await call(manifestRoute.POST as H, { cookie, method: "POST", body: { name: "J", target: "user" } });
      return new URL(((await r.json()) as { action: string }).action).searchParams.get("state")!;
    };
    const { fn } = stubFetch({ "POST /api/app-manifests": () => Response.json(conversion(), { status: 201 }) });
    const cb = async (state: string, cookie: string | null = ownerCookie, code = "code123") =>
      (await call(callbackRoute.GET as H, { cookie, path: `/api/github/app/callback?code=${code}&state=${encodeURIComponent(state)}` })).headers.get(
        "location",
      );

    expect(await cb("made-up-state")).toContain("github_app=state");
    // Another browser session of the same admin.
    const s1 = await start();
    expect(await cb(s1, createSession(owner).token)).toContain("github_app=state");
    expect(await cb(s1)).toContain("github_app=state"); // already used up by the failed attempt
    // Signed out / not an admin.
    const s2 = await start();
    expect(await cb(s2, null)).toContain("github_app=forbidden");
    expect(await cb(s2, createSession(other).token)).toContain("github_app=forbidden");
    // Expired.
    const s3 = await start();
    getDb()
      .update(schema.githubAppStates)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .run();
    expect(await cb(s3)).toContain("github_app=state");
    // Junk code.
    expect(await cb(await start(), ownerCookie, "bad%20code")).toContain("github_app=missing_code");
    expect(fn).not.toHaveBeenCalled();
    // GitHub refusing the code.
    stubFetch({ "POST /api/app-manifests": () => Response.json({ message: "Not Found" }, { status: 404 }) });
    expect(await cb(await start())).toContain("github_app=conversion");
    expect(ghApp.storedApp()).toBeNull();
    expect(recentAudit(50).filter((a) => a.action === "github.app_create" && a.result === "error").length).toBeGreaterThanOrEqual(5);
  });
});

describe("installations, tokens and the resolver", () => {
  it("lists installations with the App JWT, flags accounts outside the allowlist, caches tokens until expiry-5min", async () => {
    await createApp();
    connections.createGithubConnection(me(), { label: "Momentum", owner: "momentumbets", token: PAT, repos: [] }, cid);
    const { calls, minted } = stubAppApi([
      { id: 11, account: "NickBolles", selection: "all", repos: ["jarvis", "dotfiles"] },
      { id: 12, account: "momentumbets", type: "Organization", repos: ["odds"] },
      { id: 13, account: "evil-corp", type: "Organization", repos: ["x"] },
    ]);
    const res = await call(refreshRoute.POST as H, { method: "POST", path: "/api/github/app/installations/refresh" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(secretsIn(text)).toEqual([]);
    expect(text).not.toContain("inst_11_");
    const { app } = JSON.parse(text) as { app: { installations: { account: string; allowed: boolean; repos: string[] | null }[]; allowlist: string[] } };
    expect(app.allowlist.sort()).toEqual(["momentumbets", "nickbolles"]);
    expect(app.installations).toEqual([
      expect.objectContaining({ account: "evil-corp", allowed: false, repos: null }),
      expect.objectContaining({ account: "momentumbets", allowed: true, repos: ["odds"] }),
      expect.objectContaining({ account: "NickBolles", allowed: true, repos: ["jarvis", "dotfiles"] }),
    ]);
    // Never minted a token for the flagged installation.
    expect(calls.some((c) => c.url.includes("/installations/13/"))).toBe(false);
    expect(minted).toHaveLength(2);

    // Resolver: App installation first (token cached), then the PAT, then env.
    const a = await resolveGithubToken("momentumbets", "odds");
    expect(a).toMatchObject({ source: "app", installationId: 12, backoffKey: "app:12" });
    expect(await resolveGithubToken("MomentumBets", "odds")).toMatchObject({ token: a!.token });
    expect(minted).toHaveLength(2); // the refresh's token is reused
    expect(await resolveGithubToken("momentumbets", "web")).toMatchObject({ source: "connection", token: PAT }); // not in the selection
    expect(await resolveGithubToken("evil-corp", "x")).toBeNull(); // flagged, no PAT, no env
    vi.stubEnv("JARVIS_GITHUB_TOKEN", "synthetic-env-value");
    expect(await resolveGithubToken("evil-corp", "x")).toMatchObject({ source: "env" });
    expect(await resolveGithubToken("nickbolles", "anything")).toMatchObject({ source: "app", installationId: 11 });

    // Expiry: a token within 5 minutes of expiring is replaced.
    const t1 = await ghApp.installationToken(12);
    expect(await ghApp.installationToken(12, Date.now() + 54 * 60_000)).toBe(t1);
    const t2 = await ghApp.installationToken(12, Date.now() + 56 * 60_000);
    expect(t2).not.toBe(t1);

    // Allowlist edits take effect; non-admins can't change it.
    expect((await call(appRoute.PATCH as H, { cookie: createSession(other).token, method: "PATCH", body: { allowlist: ["evil-corp"] } })).status).toBe(403);
    const patched = await call(appRoute.PATCH as H, { method: "PATCH", body: { allowlist: ["nickbolles"] } });
    expect((await patched.json()).app).toMatchObject({ allowlist: ["nickbolles"], allowlistIsDefault: false });
    expect(await resolveGithubToken("momentumbets", "odds")).toMatchObject({ source: "connection" });
    expect((await call(appRoute.PATCH as H, { method: "PATCH", body: { allowlist: null } })).status).toBe(200);
    expect(ghApp.appAllowlist().isDefault).toBe(true);

    const auditText = JSON.stringify(recentAudit(500));
    expect(secretsIn(auditText)).toEqual([]);
    expect(auditText).not.toContain(t1);
  });

  it("PR readback uses the installation token and records CI state (read-only GETs)", async () => {
    await createApp();
    const api = stubAppApi([{ id: 21, account: "momentumbets", type: "Organization", repos: ["odds"] }]);
    ghApp.setAppAllowlist(me(), ["momentumbets"], cid);
    await ghApp.refreshInstallations(owner, cid);
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Momentum" }, cid);
    const item = store.createItem(u, { kind: "thread", title: "V5", parentId: area.id }, cid);
    const link = await store.addLink(u, item.id, { kind: "github_pr", url: "https://github.com/momentumbets/odds/pull/5" }, cid);
    const sha = "a".repeat(40);
    const reads: Call[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.includes("/repos/")) {
          reads.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization") });
          if (url.endsWith("/pulls/5")) return Response.json({ number: 5, state: "closed", merged: true, head: { sha } });
          if (url.includes("/check-suites"))
            return Response.json({ check_suites: [{ status: "completed", conclusion: "success", latest_check_runs_count: 3 }] });
          if (url.endsWith("/status")) return Response.json({ state: "success", total_count: 1 });
        }
        return prev(url, init);
      }),
    );
    const after = await store.refreshLink(u, link.id, cid);
    expect(after).toMatchObject({ externalState: "merged", checksState: "success" });
    expect(reads.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
    expect(reads.every((r) => r.auth === `Bearer ${api.minted[0]}`)).toBe(true);
    expect(reads[1]!.url).toContain(`/commits/${sha}/`);
  });
});

async function webhook(event: string, payload: unknown, secret: string, delivery: string = crypto.randomUUID()) {
  const body = JSON.stringify(payload);
  return webhookRoute.POST(
    new NextRequest("http://jarvis.test/api/work/github/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signBody(secret, body) },
      body,
    }),
    { params: Promise.resolve({}) },
  );
}

describe("webhooks with the App secret", () => {
  it("accepts the App secret and the legacy secret; keeps installations current; ignores accounts outside the allowlist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 404 })),
    );
    const pr = (n: number, owner = "nickbolles") => ({
      action: "closed",
      installation: { id: 31 },
      repository: { full_name: `${owner}/jarvis`, owner: { login: owner } },
      pull_request: { number: n, state: "closed", merged: true },
    });
    // No App and no legacy secret yet: refused.
    expect((await webhook("pull_request", pr(1), APP_HOOK_SECRET)).status).toBe(401);
    await createApp();
    const { secret: legacy } = connections.regenerateWebhookSecret(me(), cid);
    expect((await webhook("ping", {}, APP_HOOK_SECRET)).status).toBe(200);
    expect((await webhook("ping", {}, legacy)).status).toBe(200);
    expect((await webhook("ping", {}, "wrong")).status).toBe(401);

    // installation.created (allowlisted owner) → stored with its repos; evil-corp → stored but flagged.
    const created = await webhook(
      "installation",
      {
        action: "created",
        installation: { id: 31, account: { login: "NickBolles", type: "User" }, repository_selection: "selected" },
        repositories: [{ name: "jarvis" }],
      },
      APP_HOOK_SECRET,
    );
    expect(await created.json()).toMatchObject({ installation: 31, allowed: true });
    await webhook(
      "installation",
      { action: "created", installation: { id: 32, account: { login: "evil-corp", type: "Organization" } }, repositories: [] },
      APP_HOOK_SECRET,
    );
    await webhook(
      "installation_repositories",
      {
        action: "added",
        installation: { id: 31, account: { login: "NickBolles" } },
        repository_selection: "selected",
        repositories_added: [{ name: "dotfiles" }],
      },
      APP_HOOK_SECRET,
    );
    expect(ghApp.publicApp()!.installations).toEqual([
      expect.objectContaining({ id: 32, allowed: false }),
      expect.objectContaining({ id: 31, allowed: true, repos: ["jarvis", "dotfiles"] }),
    ]);
    // installation events signed with the legacy secret are not trusted.
    expect((await webhook("installation", { action: "deleted", installation: { id: 31, account: { login: "NickBolles" } } }, legacy)).status).toBe(202);
    expect(ghApp.publicApp()!.installations).toHaveLength(2);

    // A linked PR changes via an App delivery; evil-corp's deliveries are ignored.
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Jarvis" }, cid);
    const item = store.createItem(u, { kind: "thread", title: "App flow", parentId: area.id }, cid);
    const link = await store.addLink(u, item.id, { kind: "github_pr", url: "https://github.com/NickBolles/jarvis/pull/7" }, cid);
    const evilLink = await store.addLink(u, item.id, { kind: "github_pr", url: "https://github.com/evil-corp/jarvis/pull/7", role: "reference" }, cid);
    const ignored = await webhook("pull_request", { ...pr(7, "evil-corp"), installation: { id: 32 } }, APP_HOOK_SECRET);
    expect(ignored.status).toBe(202);
    expect(await ignored.json()).toMatchObject({ reason: "installation_not_allowed" });
    expect(store.getDetail(owner, item.id).links.find((l) => l.id === evilLink.id)!.externalState).toBe("open");
    expect(recentAudit(20).find((a) => a.action === "work.github_webhook" && a.result === "rejected")).toBeTruthy();

    // pull_request_review carries the PR's state too.
    expect(
      await (await webhook("pull_request_review", { ...pr(7), action: "submitted", review: { state: "approved" } }, APP_HOOK_SECRET)).json(),
    ).toMatchObject({
      linked: 1,
      changed: 1,
    });
    expect(store.getDetail(owner, item.id).links.find((l) => l.id === link.id)!.externalState).toBe("merged");

    // check_suite → CI state on the linked PR (the combined read isn't possible here: no token covers it → the event's own state).
    const checks = (conclusion: string, delivery?: string) =>
      webhook(
        "check_suite",
        {
          action: "completed",
          installation: { id: 31 },
          repository: { full_name: "NickBolles/jarvis", owner: { login: "NickBolles" } },
          check_suite: { head_sha: "b".repeat(40), status: "completed", conclusion, pull_requests: [{ number: 7 }] },
        },
        APP_HOOK_SECRET,
        delivery,
      );
    expect(await (await checks("failure", "chk-1")).json()).toMatchObject({ linked: 1, changed: 1 });
    expect(store.getDetail(owner, item.id).links.find((l) => l.id === link.id)!.checksState).toBe("failure");
    expect(await (await checks("success", "chk-1")).json()).toMatchObject({ duplicate: true });
    await checks("success");
    expect(store.getDetail(owner, item.id).links.find((l) => l.id === link.id)!.checksState).toBe("success");

    // installation.deleted forgets it.
    await webhook("installation", { action: "deleted", installation: { id: 31, account: { login: "NickBolles" } } }, APP_HOOK_SECRET);
    expect(ghApp.publicApp()!.installations.map((i) => i.id)).toEqual([32]);
    expect(secretsIn(JSON.stringify(recentAudit(500)))).toEqual([]);
  });

  it("forgetting the App removes its credentials, installations and secret (admin only)", async () => {
    await createApp();
    expect((await call(appRoute.DELETE as H, { cookie: createSession(other).token, method: "DELETE" })).status).toBe(403);
    expect((await call(appRoute.DELETE as H, { method: "DELETE" })).status).toBe(200);
    expect(ghApp.storedApp()).toBeNull();
    expect(ghApp.appWebhookSecret()).toBeNull();
    expect(getDb().select().from(schema.githubAppInstallations).where(eq(schema.githubAppInstallations.id, 1)).all()).toHaveLength(0);
    expect((await webhook("ping", {}, APP_HOOK_SECRET)).status).toBe(401);
    expect(recentAudit(10).map((a) => a.action)).toContain("github.app_forget");
  });
});

describe("connect an existing App", () => {
  const appInfo = (init: RequestInit, id = 4242) => {
    const token = new Headers(init.headers).get("authorization")!.slice(7);
    const claims = verifyJwt(token, publicKey);
    return claims && claims.iss === String(id)
      ? Response.json({ id, slug: "jarvis-work-nickbolles", name: "Jarvis Work", owner: { login: "NickBolles", type: "User" }, client_id: "Iv1.synthetic" })
      : Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 });
  };

  it("verifies App ID + private key with GET /app, stores them write-only, reads installations", async () => {
    const other_ = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const api = stubAppApi([{ id: 51, account: "NickBolles", repos: ["Personal-dashboard"] }]);
    const prevFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => (new URL(url).pathname === "/api/app" ? appInfo(init) : prevFetch(url, init))),
    );
    const post = (body: unknown, cookie = ownerCookie) => call(connectRoute.POST as H, { cookie, method: "POST", path: "/api/github/app/connect", body });
    expect((await post({ appId: 4242, pem: PEM }, createSession(other).token)).status).toBe(403);
    expect((await post({ appId: 4242, pem: "not a key" })).status).toBe(400);
    expect((await post({ appId: 4242, pem: other_ })).status).toBe(400); // GitHub refuses the JWT
    expect(ghApp.storedApp()).toBeNull();

    const res = await post({ appId: "4242", pem: PEM, webhookSecret: APP_HOOK_SECRET });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(secretsIn(text)).toEqual([]);
    expect(JSON.parse(text).app).toMatchObject({
      appId: 4242,
      slug: "jarvis-work-nickbolles",
      owner: "NickBolles",
      webhookSecretSet: true,
      installations: [expect.objectContaining({ id: 51, allowed: true, repos: ["Personal-dashboard"] })],
    });
    const row = ghApp.storedApp()!;
    expect(row.clientSecretCipher).toBeNull();
    expect(secretsIn(JSON.stringify(row))).toEqual([]);
    expect(ghApp.appWebhookSecret()).toBe(APP_HOOK_SECRET);
    expect(api.minted).toHaveLength(1);
    expect((await post({ appId: 4242, pem: PEM })).status).toBe(409);

    // Replacing the webhook secret (write-only).
    const next = "replacement-hook-secret-" + "0123456789";
    const patched = await call(appRoute.PATCH as H, { method: "PATCH", body: { webhookSecret: next } });
    expect(await patched.text()).not.toContain(next);
    expect(ghApp.appWebhookSecret()).toBe(next);
    expect((await call(appRoute.PATCH as H, { method: "PATCH", body: { webhookSecret: "short" } })).status).toBe(400);
    const audits = JSON.stringify(recentAudit(200));
    expect(secretsIn(audits)).toEqual([]);
    expect(audits).not.toContain(next);
    expect(recentAudit(50).map((a) => a.action)).toEqual(expect.arrayContaining(["github.app_connect", "github.app_refresh", "github.app_webhook_secret"]));
  });

  it("scripts/import-github-app.mjs stores the JSON encrypted and prints only id/slug/accounts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-import-"));
    const key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir, "secret.key"), key.toString("base64"));
    const dbFile = path.join(dir, "jarvis.db");
    const sqlite = new Database(dbFile);
    migrate(drizzle(sqlite), { migrationsFolder: path.resolve("drizzle") });
    sqlite.prepare("insert into users (id, name, role) values ('usr_admin', 'Owner', 'admin')").run();
    sqlite.close();
    const json = path.join(dir, "github-app.json");
    fs.writeFileSync(
      json,
      JSON.stringify({
        id: 4242,
        slug: "jarvis-work-nickbolles",
        client_id: "Iv1.synthetic",
        client_secret: CLIENT_SECRET,
        webhook_secret: APP_HOOK_SECRET,
        pem: PEM,
      }),
      { mode: 0o600 },
    );
    // A tiny GitHub for the child process: GET /app and /app/installations with JWT checks.
    const server = http.createServer((req, res) => {
      const claims = verifyJwt((req.headers.authorization ?? "").slice(7), publicKey);
      res.setHeader("content-type", "application/json");
      if (!claims || claims.iss !== "4242" || req.method !== "GET") return res.writeHead(401).end("{}");
      if (req.url === "/app")
        return res.end(JSON.stringify({ id: 4242, slug: "jarvis-work-nickbolles", name: "Jarvis Work", owner: { login: "NickBolles", type: "User" } }));
      if (req.url?.startsWith("/app/installations"))
        return res.end(
          JSON.stringify([
            { id: 175021456, account: { login: "NickBolles", type: "User" }, repository_selection: "selected" },
            { id: 175021594, account: { login: "momentumbets", type: "Organization" }, repository_selection: "selected" },
          ]),
        );
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const run = (...extra: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
          process.execPath,
          ["scripts/import-github-app.mjs", json, ...extra],
          {
            env: { PATH: process.env.PATH, JARVIS_DATA_DIR: dir, JARVIS_GITHUB_API_URL: `http://127.0.0.1:${port}` } as unknown as NodeJS.ProcessEnv,
            encoding: "utf8",
          },
          (err: Error | null, stdout: string, stderr: string) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
        );
      });
    try {
      const first = await run("--allow", "nickbolles,momentumbets");
      expect(first.code).toBe(0);
      expect(first.out).toContain("Imported GitHub App 4242 (jarvis-work-nickbolles), owner NickBolles");
      expect(first.out).toContain("- NickBolles (User), installation 175021456: in use");
      expect(first.out).toContain("- momentumbets (Organization), installation 175021594: in use");
      expect(secretsIn(first.out)).toEqual([]);
      // Refuses to overwrite without --replace.
      const again = await run();
      expect(again.code).toBe(1);
      expect(again.out).toContain("--replace");
      expect(secretsIn(again.out)).toEqual([]);

      const db = new Database(dbFile, { readonly: true });
      const row = db.prepare("select * from github_apps").get() as Record<string, string>;
      const insts = db.prepare("select id, account_key from github_app_installations order by id").all();
      const allow = db.prepare("select value from settings where key = 'work.github.app_allowlist'").get() as { value: string };
      const auditRow = db.prepare("select detail from audit_log where action = 'github.app_import'").get() as { detail: string };
      db.close();
      expect(secretsIn(JSON.stringify(row))).toEqual([]);
      expect(secretsIn(auditRow.detail)).toEqual([]);
      const dec = (payload: string) => {
        const [, iv, tag, data] = payload.split(".");
        const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64"));
        d.setAuthTag(Buffer.from(tag!, "base64"));
        return Buffer.concat([d.update(Buffer.from(data!, "base64")), d.final()]).toString("utf8");
      };
      expect(dec(row.pem_cipher!)).toBe(PEM.trim());
      expect(dec(row.webhook_secret_cipher!)).toBe(APP_HOOK_SECRET);
      expect(dec(row.client_secret_cipher!)).toBe(CLIENT_SECRET);
      expect(row).toMatchObject({ app_id: 4242, slug: "jarvis-work-nickbolles", owner_login: "NickBolles", created_by: "usr_admin" });
      expect(insts).toEqual([
        { id: 175021456, account_key: "nickbolles" },
        { id: 175021594, account_key: "momentumbets" },
      ]);
      expect(JSON.parse(allow.value)).toEqual(["nickbolles", "momentumbets"]);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
