/**
 * People, roles and capabilities: who can sign in, what each person sees on
 * Home / search / "Ask about", which alerts reach them, and which API routes
 * they may call. Conversations are private unless shared.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { AuthError, claimInstance, createSession, userById, userFromProxyHeader, userFromSessionToken, verifyLogin } from "@/server/auth";
import { capabilitiesFor } from "@/server/access";
import { createInvite, createPerson, deletePerson, invitePreview, listPeople, redeemInvite, updatePerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import type { IntegrationKind } from "@/integrations/registry";
import { getPreferences, updatePreferences } from "@/server/settings";
import { getHome, refreshSource, setActionPref } from "@/server/sources";
import { buildContext } from "@/server/context";
import { search } from "@/server/search";
import { notifyHolders, usersWith } from "@/server/notifications";
import { createSession as createHermesSession, getSessionDetail, listSessions, startRun, updateSession } from "@/integrations/hermes/service";
import { defaultCapabilities } from "@/lib/modules";
import { config } from "@/server/config";

import * as sessionsRoute from "@/app/api/hermes/sessions/route";
import * as settingsRoute from "@/app/api/settings/route";
import * as peopleRoute from "@/app/api/people/route";
import * as joinRoute from "@/app/api/auth/join/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as actionsRoute from "@/app/api/actions/route";
import * as sourceRoute from "@/app/api/sources/[source]/route";

let server: Server;
let base: string;
let owner: string;
let wife: string;
let kid: string;
let tablet: string;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, url: string, userId: string | null, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-jarvis-csrf": "1" };
  if (userId) headers.cookie = `jarvis_session=${createSession(userId).token}`;
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string } };
}

const as = (id: string) => userById(id)!;

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JARVIS_MOCK_UPSTREAM_URL = base;
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  updatePreferences({ timezone: "America/Chicago", onboarding: { completedAt: new Date().toISOString() } });
  for (const [k, p] of Object.entries(demoPresets()!)) saveIntegration(k as IntegrationKind, { enabled: true, config: p!.config, secrets: p!.secrets });
  wife = createPerson({ name: "Sam", username: "sam", role: "adult", passcode: "samsecret1" }, owner).id;
  kid = createPerson({ name: "Ava", username: "ava", role: "kid", passcode: "avasecret1" }, owner).id;
  tablet = createPerson({ name: "Kitchen", username: "kitchen", role: "household", passcode: "4321" }, owner).id;
  for (const s of ["skylight", "home_assistant", "todos", "hermes", "daily_compass"] as const) await refreshSource(s);
});

afterAll(() => server?.close());
beforeEach(async () => {
  await fetch(`${base}/__mock/reset`, { method: "POST", body: "{}" });
});

describe("roles and capabilities", () => {
  it("kids get the household calendar and Skylight, not Hermes or home controls", () => {
    const caps = capabilitiesFor(kid, "kid");
    expect(caps.has("skylight.view")).toBe(true);
    expect(caps.has("home_assistant.calendar")).toBe(true);
    expect(caps.has("hermes.chat")).toBe(false);
    expect(caps.has("home_assistant.control_doors")).toBe(false);
    expect(caps.has("finance.view")).toBe(false);
  });

  it("the household tablet sees and controls the home but has no Hermes or finances", () => {
    const caps = capabilitiesFor(tablet, "household");
    expect([...caps].sort()).toEqual(defaultCapabilities("household").sort());
    expect(caps.has("home_assistant.cameras")).toBe(true);
    expect(caps.has("hermes.chat")).toBe(false);
  });

  it("per-person grants and revocations sit on top of the role; admin can't be granted", () => {
    updatePerson(kid, { capabilities: { "todos.view": true, "home_assistant.calendar": false, admin: true } as Record<string, boolean> }, owner);
    const caps = capabilitiesFor(kid, "kid");
    expect(caps.has("todos.view")).toBe(true);
    expect(caps.has("home_assistant.calendar")).toBe(false);
    expect(caps.has("admin")).toBe(false);
    // Only differences are stored; going back to the default removes the row.
    updatePerson(kid, { capabilities: { "todos.view": false, "home_assistant.calendar": true } }, owner);
    expect(getDb().select().from(schema.userCapabilities).where(eq(schema.userCapabilities.userId, kid)).all()).toEqual([]);
  });

  it("changing the role resets overrides to the new role's defaults", () => {
    const p = createPerson({ name: "Temp", username: "temp", role: "kid", passcode: "tempsecret" }, owner).id;
    updatePerson(p, { capabilities: { "todos.view": true } }, owner);
    updatePerson(p, { role: "adult" }, owner);
    expect([...capabilitiesFor(p, "adult")].sort()).toEqual(defaultCapabilities("adult").sort());
    deletePerson(p, owner);
  });

  it("there is always an admin, and you can't disable or remove yourself", () => {
    expect(() => updatePerson(owner, { role: "adult" }, wife)).toThrow(/at least one admin/);
    expect(() => updatePerson(owner, { disabled: true }, owner)).toThrow();
    expect(() => deletePerson(owner, wife)).toThrow();
  });
});

describe("signing in", () => {
  it("passcode-only sign-in is the owner's; others sign in with their name", () => {
    expect(verifyLogin("secret123", "p1").id).toBe(owner);
    expect(() => verifyLogin("samsecret1", "p2")).toThrow(AuthError);
    expect(verifyLogin("samsecret1", "p3", "Sam").id).toBe(wife);
    expect(verifyLogin("4321", "p4", "kitchen").id).toBe(tablet);
    expect(() => verifyLogin("wrong", "p5", "sam")).toThrow(/Incorrect name or passcode/);
  });

  it("only the household tablet may use a short PIN", () => {
    expect(() => createPerson({ name: "X", username: "xx", role: "adult", passcode: "1234" }, owner)).toThrow(/6 characters/);
  });

  it("invites work once, then are gone", async () => {
    const { id, invite } = createPerson({ name: "Grandma", username: "grandma", role: "adult" }, owner);
    expect(invite).toBeDefined();
    expect(invitePreview(invite!.code)).toMatchObject({ name: "Grandma", username: "grandma", role: "adult" });
    const res = await call(joinRoute.POST, "/api/auth/join", null, { method: "POST", body: { code: invite!.code.toLowerCase(), passcode: "grandmapass" } });
    expect(res.status).toBe(200);
    expect(verifyLogin("grandmapass", "g1", "grandma").id).toBe(id);
    expect(() => redeemInvite(invite!.code, "another-pass")).toThrow(/wrong, used or expired/);
    // A new invite replaces the old one.
    const a = createInvite(id, owner);
    const b = createInvite(id, owner);
    expect(invitePreview(a.code)).toBeUndefined();
    expect(invitePreview(b.code)).toBeDefined();
    deletePerson(id, owner);
  });

  it("disabling someone signs them out and blocks sign-in", () => {
    const p = createPerson({ name: "Gone", username: "gone", role: "adult", passcode: "gonepass1" }, owner).id;
    const s = createSession(p);
    updatePerson(p, { disabled: true }, owner);
    expect(userFromSessionToken(s.token)).toBeNull();
    expect(() => verifyLogin("gonepass1", "d1", "gone")).toThrow(AuthError);
    expect(userById(p)).toBeNull();
    deletePerson(p, owner);
  });

  it("proxy mode maps sign-in names to people; unknown names get nothing", () => {
    const prev = process.env.JARVIS_AUTH_MODE;
    process.env.JARVIS_AUTH_MODE = "proxy";
    try {
      expect(config.authMode).toBe("proxy");
      expect(userFromProxyHeader("Sam")?.id).toBe(wife);
      // The owner predates sign-in names, so they adopt the first unknown proxy name…
      expect(userFromProxyHeader("nick")?.id).toBe(owner);
      expect(userFromProxyHeader("NICK")?.id).toBe(owner);
      // …and after that, unknown names must be added in Settings → People first.
      expect(userFromProxyHeader("stranger")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.JARVIS_AUTH_MODE;
      else process.env.JARVIS_AUTH_MODE = prev;
    }
  });
});

describe("API routes check capabilities", () => {
  it("a kid can't open Hermes; an adult can", async () => {
    expect((await call(sessionsRoute.GET, "/api/hermes/sessions", kid)).status).toBe(403);
    expect((await call(sessionsRoute.GET, "/api/hermes/sessions", wife)).status).toBe(200);
  });

  it("people management is admin-only", async () => {
    expect((await call(peopleRoute.GET, "/api/people", wife)).status).toBe(403);
    const r = await call(peopleRoute.GET, "/api/people", owner);
    expect((r.body.people as unknown[]).length).toBeGreaterThanOrEqual(4);
  });

  it("everyone edits their own preferences; household settings are admin-only", async () => {
    expect((await call(settingsRoute.PUT, "/api/settings", wife, { method: "PUT", body: { timezone: "UTC" } })).status).toBe(403);
    const r = await call(settingsRoute.PUT, "/api/settings", wife, { method: "PUT", body: { displayName: "Samantha", quietHours: { start: "21:00" } } });
    expect(r.status).toBe(200);
    expect(getPreferences(wife).displayName).toBe("Samantha");
    expect(getPreferences(wife).quietHours.start).toBe("21:00");
    // The owner's own preferences are untouched.
    expect(getPreferences(owner).displayName).not.toBe("Samantha");
    expect(getPreferences(owner).quietHours.start).toBe("22:00");
    // Household settings are shared.
    expect(getPreferences(wife).timezone).toBe("America/Chicago");
  });

  it("/api/auth/me lists capabilities and modules", async () => {
    const r = await call(meRoute.GET, "/api/auth/me", kid);
    expect(r.body.modules).toEqual(expect.arrayContaining(["skylight", "home_assistant"]));
    expect(r.body.modules).not.toContain("hermes");
    expect((r.body.user as { role: string }).role).toBe("kid");
  });

  it("acting on a card needs that module's capability", async () => {
    const home = await getHome(as(owner), { live: false });
    const todo = [...home.now, ...home.later.laterToday, ...home.later.upcoming].find((a) => a.source === "todos")!;
    expect(todo).toBeDefined();
    const r = await call(actionsRoute.POST, "/api/actions", kid, { method: "POST", body: { actionId: todo.id, kind: "complete" } });
    expect(r.status).toBe(403);
  });

  it("a kid sees the Home Assistant calendar but not doors or alerts", async () => {
    const r = await call(sourceRoute.GET, "/api/sources/home_assistant?cached=1", kid, { params: { source: "home_assistant" } });
    expect(r.status).toBe(200);
    const data = r.body.data as { homeExceptions: unknown[]; events?: unknown[]; extra?: unknown };
    expect(data.homeExceptions).toEqual([]);
    expect(data.extra).toBeUndefined();
    expect((await call(sourceRoute.GET, "/api/sources/todos?cached=1", kid, { params: { source: "todos" } })).status).toBe(404);
  });
});

describe("what each person sees", () => {
  it("Home only includes modules the person can see", async () => {
    const kidHome = await getHome(as(kid), { live: false });
    const sources = new Set(kidHome.sources.map((s) => s.source));
    expect(sources.has("skylight")).toBe(true);
    expect(sources.has("todos")).toBe(false);
    expect(sources.has("hermes")).toBe(false);
    expect(sources.has("daily_compass")).toBe(false);
    expect([...kidHome.now, ...kidHome.later.upcoming].every((a) => a.source === "skylight")).toBe(true);
    expect(kidHome.glance.homeExceptions).toEqual([]);
    expect(kidHome.glance.compass).toBeUndefined();
  });

  it("pins and acknowledgements are per person", async () => {
    const home = await getHome(as(wife), { live: false });
    const a = [...home.now, ...home.later.laterToday, ...home.later.upcoming][0]!;
    setActionPref(wife, a.id, { pinned: true });
    const mine = await getHome(as(wife), { live: false });
    const theirs = await getHome(as(owner), { live: false });
    const find = (h: typeof mine) => [...h.now, ...h.later.laterToday, ...h.later.upcoming].find((x) => x.id === a.id);
    expect(find(mine)?.pinned).toBe(true);
    expect(find(theirs)?.pinned).toBeFalsy();
  });

  it("'Ask about' context only includes what the person may see", async () => {
    await expect(buildContext(as(kid), ["todos"], undefined)).rejects.toThrow(/access/);
    const homeCtx = await buildContext(as(kid), ["home_assistant"], undefined);
    expect(homeCtx).not.toMatch(/Exceptions|Controllable/);
    const overview = await buildContext(as(kid), ["overview"], undefined);
    expect(overview).not.toMatch(/\[todos:/);
  });

  it("search is scoped: no conversations or people for a kid", async () => {
    const kidResults = await search(as(kid), "skylight");
    expect(kidResults.results.some((r) => r.kind === "page" && r.href === "/skylight")).toBe(true);
    const kidAll = await search(as(kid), "a");
    expect(kidAll.results.every((r) => r.kind !== "conversation" && r.kind !== "person")).toBe(true);
    const adminPeople = await search(as(owner), "sam");
    expect(adminPeople.results.some((r) => r.kind === "person")).toBe(true);
  });
});

describe("alerts go to the right people", () => {
  it("home alerts reach whoever can see the home, not kids", () => {
    const holders = usersWith("home_assistant.view");
    expect(holders).toEqual(expect.arrayContaining([owner, wife, tablet]));
    expect(holders).not.toContain(kid);
    notifyHolders(
      {
        type: "t",
        category: "ha_critical",
        severity: "high",
        title: "Garage open",
        body: "x",
        source: "home_assistant",
        deepLink: "/home-control",
        dedupeKey: "people-test",
      },
      "home_assistant.view",
    );
    const rows = getDb().select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, "people-test")).all();
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([owner, wife, tablet]));
  });

  it("push follows each person's own category settings", () => {
    updatePreferences({ notificationCategories: { ha_critical: { push: false } } }, wife);
    notifyHolders(
      { type: "t", category: "ha_critical", severity: "high", title: "Door", body: "x", source: "home_assistant", deepLink: "/", dedupeKey: "people-push" },
      "home_assistant.view",
    );
    const row = (u: string) =>
      getDb()
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.dedupeKey, "people-push"), eq(schema.notifications.userId, u)))
        .get()!;
    expect(row(wife).pushState).toBeNull();
    expect(row(owner).pushState).toBe("pending");
  });
});

describe("conversations are private unless shared", () => {
  it("someone else's conversation is invisible until shared, then read-only", async () => {
    const s = await createHermesSession(as(wife), "Anniversary ideas");
    expect((await listSessions(as(owner))).some((x) => x.id === s.id)).toBe(false);
    await expect(getSessionDetail(as(owner), s.id)).rejects.toThrow(/not found/);
    await updateSession(as(wife), s.id, { shared: true }, "c1");
    const seen = (await listSessions(as(owner))).find((x) => x.id === s.id);
    expect(seen).toMatchObject({ shared: true, readOnly: true });
    await expect(startRun(as(owner), { sessionId: s.id, input: "hi", idempotencyKey: "people-ro-1" }, "c2")).rejects.toThrow(/read-only/);
    await expect(updateSession(as(owner), s.id, { title: "mine now" }, "c3")).rejects.toThrow(/read-only/);
    expect((await listSessions(as(wife))).find((x) => x.id === s.id)?.readOnly).toBe(false);
  });

  it("conversations made outside Jarvis belong to the owner", async () => {
    const ownerList = await listSessions(as(owner));
    const wifeList = await listSessions(as(wife));
    const unowned = ownerList.filter((s) => !getDb().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, s.id)).get());
    expect(unowned.length).toBeGreaterThan(0);
    expect(wifeList.some((s) => unowned.some((u) => u.id === s.id))).toBe(false);
  });
});

describe("people listing", () => {
  it("never exposes passcode hashes", () => {
    const json = JSON.stringify(listPeople());
    expect(json).not.toMatch(/scrypt|passcodeHash/);
  });
});
