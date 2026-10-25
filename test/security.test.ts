/**
 * Security hardening (docs: audit S1–S12): client IP from the trusted proxy
 * hop, persisted per-client/per-account/global sign-in throttling, streamed
 * body caps, the Web Push endpoint allowlist, explicit ownership, Paperclip
 * link access checks and fail-closed conversation links.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { AuthError, checkThrottle, createSession, getOwner, OWNER_SETTING, recordFailure, throttleKeys, userById, verifyLogin } from "@/server/auth";
import { clientIp, normalizeIp } from "@/server/http/origin";
import { readBodyCapped } from "@/server/http/body";
import { isAllowedPushEndpoint, listSubscriptions, saveSubscription } from "@/server/notifications/push";
import { createPerson, updatePerson } from "@/server/people";
import { getSetting, setSetting } from "@/server/settings";
import { deleteLink, track } from "@/integrations/paperclip/service";
import * as store from "@/server/work/store";

import * as loginRoute from "@/app/api/auth/login/route";
import * as setupRoute from "@/app/api/auth/setup/route";
import * as passcodeRoute from "@/app/api/auth/passcode/route";
import * as pushRoute from "@/app/api/push/subscribe/route";
import * as webhookRoute from "@/app/api/work/github/webhook/route";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  handler: unknown,
  url: string,
  opts: { method?: string; body?: unknown; userId?: string; xff?: string; raw?: BodyInit; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-jarvis-csrf": "1", ...opts.headers };
  if (opts.userId) headers.cookie = `jarvis_session=${createSession(opts.userId).token}`;
  if (opts.xff) headers["x-forwarded-for"] = opts.xff;
  const body = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method: opts.method ?? "POST",
    headers,
    ...(body !== undefined ? { body, duplex: "half" } : {}),
  } as ConstructorParameters<typeof NextRequest>[1]);
  const res = await (handler as Handler)(req, { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const clearThrottle = () => getDb().delete(schema.authFailures).run();

/** A body that never ends unless the reader stops pulling. */
function endless(chunk = 64 * 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(chunk).fill(97));
    },
  });
  return { stream, pulled: () => pulled };
}

let owner: string;
let sam: string;

beforeAll(() => {
  __setTestDatabase();
});

describe("setup code (before claim)", () => {
  it("wrong setup codes are throttled per client, and the lock survives the correct code", async () => {
    const body = { setupCode: "WRONG", name: "Nick", passcode: "secret123" };
    for (let i = 0; i < 5; i++) expect((await call(setupRoute.POST, "/api/auth/setup", { body, xff: "198.51.100.7" })).status).toBe(401);
    const locked = await call(setupRoute.POST, "/api/auth/setup", { body: { ...body, setupCode: "TESTCODE" }, xff: "198.51.100.7" });
    expect(locked.status).toBe(429);
    clearThrottle();
    const ok = await call(setupRoute.POST, "/api/auth/setup", { body: { ...body, setupCode: "TESTCODE" }, xff: "198.51.100.7" });
    expect(ok.status).toBe(200);
    owner = getOwner()!.id;
    expect(getSetting(OWNER_SETTING)).toBe(owner);
    sam = createPerson({ name: "Sam", username: "sam", role: "adult", passcode: "samsecret1" }, owner).id;
  });
});

describe("client IP from the trusted proxy hop", () => {
  const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

  it("uses the right-most entry (what Traefik saw), not the client-supplied first one", () => {
    expect(clientIp(h("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(h("1.1.1.1, 2.2.2.2, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(h("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(h())).toBe("local");
  });

  it("honours more proxy hops and can ignore the header entirely", () => {
    expect(clientIp(h("6.6.6.6, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIp(h("203.0.113.9"), 3)).toBe("203.0.113.9");
    expect(clientIp(h("203.0.113.9"), 0)).toBe("local");
  });

  it("buckets IPv6 by /64 and unwraps mapped IPv4 and ports", () => {
    expect(normalizeIp("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:db8:1:2:ffff:ffff:ffff:fffe")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("[2001:db8::5]:443")).toBe("2001:db8:0:0::/64");
    expect(normalizeIp("::ffff:192.0.2.4")).toBe("192.0.2.4");
    expect(normalizeIp("192.0.2.4:5555")).toBe("192.0.2.4");
  });
});

describe("persisted sign-in throttling", () => {
  beforeEach(clearThrottle);

  it("rotating X-Forwarded-For can't bypass the per-client lock", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call(loginRoute.POST, "/api/auth/login", { body: { passcode: "nope" }, xff: `10.9.9.${i}, 203.0.113.50` });
      expect(r.status).toBe(401);
    }
    const r = await call(loginRoute.POST, "/api/auth/login", { body: { passcode: "secret123" }, xff: "1.2.3.4, 203.0.113.50" });
    expect(r.status).toBe(429);
    // The lock is in SQLite, not process memory.
    const row = getDb().select().from(schema.authFailures).where(eq(schema.authFailures.key, "ip:login:203.0.113.50")).get();
    expect(row?.count).toBe(5);
    expect(row!.lockedUntil).toBeGreaterThan(Date.now());
    // Another client is unaffected.
    expect((await call(loginRoute.POST, "/api/auth/login", { body: { passcode: "secret123" }, xff: "203.0.113.51" })).status).toBe(200);
  });

  it("locks an account after 10 failures from many IPs, with backoff", () => {
    for (let i = 0; i < 10; i++) expect(() => verifyLogin("nope", `198.18.0.${i}`)).toThrow(/Incorrect/);
    expect(() => verifyLogin("secret123", "198.18.1.1")).toThrow(expect.objectContaining({ code: "throttled" }));
    // Other people can still sign in.
    expect(verifyLogin("samsecret1", "198.18.1.1", "sam").id).toBe(sam);
    const acct = getDb()
      .select()
      .from(schema.authFailures)
      .where(eq(schema.authFailures.key, `acct:${owner}`))
      .get()!;
    expect(acct.lockedUntil - acct.lastAt).toBe(30_000);
    recordFailure(throttleKeys("login", "x", owner), acct.lastAt);
    const again = getDb()
      .select()
      .from(schema.authFailures)
      .where(eq(schema.authFailures.key, `acct:${owner}`))
      .get()!;
    expect(again.lockedUntil - again.lastAt).toBe(60_000);
  });

  it("guessing a name that doesn't exist never locks the owner", () => {
    for (let i = 0; i < 12; i++) {
      try {
        verifyLogin("nope", `198.19.0.${i}`, "nobody-here");
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError);
      }
    }
    expect(verifyLogin("secret123", "198.19.9.9").id).toBe(owner);
  });

  it("a global budget slows everyone after 50 failures in 15 minutes", () => {
    const now = Date.now();
    for (let i = 0; i < 49; i++) recordFailure(throttleKeys("login", `100.64.${i}.1`, `name:x${i}`), now);
    expect(() => checkThrottle(throttleKeys("login", "100.65.0.1"), now)).not.toThrow();
    recordFailure(throttleKeys("login", "100.64.200.1", "name:y"), now);
    expect(() => checkThrottle(throttleKeys("login", "100.65.0.1"), now + 1000)).toThrow(/Too many attempts/);
    expect(() => checkThrottle(throttleKeys("login", "100.65.0.1"), now + 10_001)).not.toThrow();
  });

  it("success clears the client and account counters, and old counters decay", () => {
    for (let i = 0; i < 3; i++) expect(() => verifyLogin("nope", "198.20.0.1")).toThrow();
    verifyLogin("secret123", "198.20.0.1");
    const left = getDb().select().from(schema.authFailures).all();
    expect(left.map((r) => r.key)).toEqual(["global:login"]);
    const t0 = Date.now() - 3 * 3600_000;
    for (let i = 0; i < 5; i++) recordFailure(["ip:login:198.20.0.2"], t0);
    recordFailure(["ip:login:198.20.0.2"]);
    expect(getDb().select().from(schema.authFailures).where(eq(schema.authFailures.key, "ip:login:198.20.0.2")).get()?.count).toBe(1);
  });

  it("passcode change: role-aware strength message and throttled current-passcode checks", async () => {
    const weak = await call(passcodeRoute.POST, "/api/auth/passcode", { userId: sam, body: { current: "samsecret1", next: "12345" } });
    expect(weak.status).toBe(401);
    expect(weak.body.error).toBe("Use at least 6 characters.");
    for (let i = 0; i < 5; i++) {
      expect(
        (await call(passcodeRoute.POST, "/api/auth/passcode", { userId: sam, body: { current: "bad", next: "newsecret1" }, xff: "203.0.113.77" })).status,
      ).toBe(401);
    }
    const locked = await call(passcodeRoute.POST, "/api/auth/passcode", {
      userId: sam,
      body: { current: "samsecret1", next: "newsecret1" },
      xff: "203.0.113.77",
    });
    expect(locked.status).toBe(429);
  });
});

describe("request body caps are enforced while streaming", () => {
  beforeEach(clearThrottle);

  it("readBodyCapped stops pulling as soon as the cap is passed", async () => {
    const e = endless();
    const req = new Request("http://x/", { method: "POST", body: e.stream, duplex: "half" } as RequestInit);
    await expect(readBodyCapped(req, 256 * 1024)).rejects.toMatchObject({ status: 413 });
    expect(e.pulled()).toBeLessThan(10);
  });

  it("public login and the GitHub webhook refuse a chunked body without Content-Length", async () => {
    const a = endless();
    const login = await call(loginRoute.POST, "/api/auth/login", { raw: a.stream });
    expect(login.status).toBe(413);
    expect(a.pulled()).toBeLessThan(10);
    const b = endless();
    const hook = await call(webhookRoute.POST, "/api/work/github/webhook", { raw: b.stream, headers: { "x-github-event": "ping" } });
    expect(hook.status).toBe(413);
    expect(b.pulled()).toBeLessThan(40);
  });

  it("a declared oversize Content-Length is refused before reading", async () => {
    const r = await call(loginRoute.POST, "/api/auth/login", { raw: "{}", headers: { "content-length": String(10 * 1024 * 1024) } });
    expect(r.status).toBe(413);
  });
});

describe("Web Push endpoint allowlist", () => {
  it("accepts the real push services over https only", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
      "https://web.push.apple.com/QGx",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/x",
      "http://hermes:8642/v1/runs",
      "http://169.254.169.254/latest/meta-data",
      "https://homeassistant.local:8123/api/services",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilnotify.windows.com/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://10.0.0.5/x",
      "not a url",
    ])
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });

  it("the subscribe route rejects internal endpoints and only deletes your own", async () => {
    const keys = { p256dh: "BNc", auth: "abc" };
    const bad = await call(pushRoute.POST, "/api/push/subscribe", { userId: sam, body: { endpoint: "http://hermes:8642/v1/x", keys } });
    expect(bad.status).toBe(400);
    expect(() => saveSubscription(sam, { endpoint: "http://192.168.1.10/", keys })).toThrow(/push service/);
    const endpoint = "https://fcm.googleapis.com/fcm/send/owner-device";
    expect((await call(pushRoute.POST, "/api/push/subscribe", { userId: owner, body: { endpoint, keys } })).status).toBe(200);
    await call(pushRoute.DELETE, "/api/push/subscribe", { method: "DELETE", userId: sam, body: { endpoint } });
    expect(listSubscriptions(owner).map((s) => s.endpoint)).toContain(endpoint);
    await call(pushRoute.DELETE, "/api/push/subscribe", { method: "DELETE", userId: owner, body: { endpoint } });
    expect(listSubscriptions(owner)).toHaveLength(0);
  });
});

describe("explicit ownership", () => {
  it("the owner can't be demoted or disabled, and a second admin doesn't move ownership", () => {
    const second = createPerson({ name: "Alex", username: "alex", role: "admin", passcode: "alexsecret1" }, owner).id;
    expect(() => updatePerson(owner, { role: "adult" }, second)).toThrow(/stays an active admin/);
    expect(() => updatePerson(owner, { disabled: true }, second)).toThrow(/stays an active admin/);
    expect(getOwner()!.id).toBe(owner);
    updatePerson(second, { role: "adult" }, owner);
  });

  it("older databases fall back to the oldest admin once and persist it", () => {
    getDb().delete(schema.settings).where(eq(schema.settings.key, OWNER_SETTING)).run();
    expect(getOwner()!.id).toBe(owner);
    expect(getSetting(OWNER_SETTING)).toBe(owner);
    // The stored owner wins over "oldest admin".
    setSetting(OWNER_SETTING, owner);
  });
});

describe("conversation access for Paperclip links and Work links", () => {
  it("Paperclip track/unlink refuse conversations you can't open", async () => {
    // A Hermes-direct conversation (no session_meta) belongs to the owner.
    await expect(track({ mode: "create", sessionId: "owner-private", title: "Leak it" }, userById(sam)!, "c1")).rejects.toMatchObject({ status: 404 });
    const id = "lnk_test";
    getDb()
      .insert(schema.entityLinks)
      .values({
        id,
        sourceType: "hermes_session",
        sourceId: "owner-private",
        targetSystem: "paperclip",
        targetType: "issue",
        targetId: "iss1",
        targetIdentifier: "J-1",
        targetTitle: "x",
        relationship: "related_to",
        createdBy: "user",
      })
      .run();
    expect(() => deleteLink(id, userById(sam)!, "c2")).toThrow(/Link not found/);
    deleteLink(id, userById(owner)!, "c3");
    expect(getDb().select().from(schema.entityLinks).where(eq(schema.entityLinks.id, id)).get()).toBeUndefined();
  });

  it("linking a conversation never skips the access check when Hermes is unreachable", async () => {
    const mine = store.createItem(userById(sam)!, { kind: "note", title: "Sam's note" }, "c4");
    // Hermes isn't configured here, so the upstream read fails: access is still decided locally, and Sam is refused.
    await expect(store.addLink(userById(sam)!, mine.id, { kind: "chat_session", targetId: "owner-private" }, "c5")).rejects.toMatchObject({ status: 404 });
    const ownerItem = store.createItem(userById(owner)!, { kind: "note", title: "Owner note" }, "c6");
    const link = await store.addLink(userById(owner)!, ownerItem.id, { kind: "chat_session", targetId: "owner-private" }, "c7");
    expect(link.targetId).toBe("owner-private");
  });
});
