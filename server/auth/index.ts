import "server-only";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { config } from "@/server/config";
import { getDb, schema } from "@/server/db";
import { hashPasscode, newId, randomToken, safeEqual, sha256, verifyPasscode } from "@/server/crypto";
import { getSetting, setSetting } from "@/server/settings";
import { DAY } from "@/lib/time";

export const SESSION_COOKIE = "jarvis_session";

export type CurrentUser = { id: string; name: string; via: "session" | "proxy" };

export function getOwner() {
  return getDb().select().from(schema.users).limit(1).get();
}

export function isClaimed() {
  return Boolean(getOwner());
}

/**
 * One-time code required to claim a fresh instance, so nobody else on the
 * network can race you to onboarding. Printed to the server log on boot.
 */
export function getSetupCode(): string {
  if (config.setupCode) return config.setupCode;
  let code = getSetting<string>("setup_code");
  if (!code) {
    code = randomToken(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
    setSetting("setup_code", code);
  }
  return code;
}

export function logSetupCodeIfUnclaimed() {
  if (config.authMode === "local" && !isClaimed()) {
    console.log(
      `\n[jarvis] Instance not yet claimed. Setup code: ${getSetupCode()}\n[jarvis] Open the app and enter this code to finish onboarding.\n`,
    );
  }
}

export function claimInstance(input: { setupCode: string; name: string; passcode: string }) {
  if (isClaimed()) throw new AuthError("already_claimed", "This Jarvis instance is already set up.");
  if (!safeEqual(input.setupCode.trim().toUpperCase(), getSetupCode().toUpperCase())) {
    throw new AuthError("bad_setup_code", "That setup code is not correct. Check the server logs.");
  }
  if (input.passcode.length < 6) throw new AuthError("weak_passcode", "Use at least 6 characters.");
  const id = newId("usr");
  getDb()
    .insert(schema.users)
    .values({ id, name: input.name.trim() || "Owner", passcodeHash: hashPasscode(input.passcode) })
    .run();
  return id;
}

export function changePasscode(userId: string, current: string, next: string) {
  const user = getDb().select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.passcodeHash || !verifyPasscode(current, user.passcodeHash)) {
    throw new AuthError("bad_passcode", "Current passcode is incorrect.");
  }
  if (next.length < 6) throw new AuthError("weak_passcode", "Use at least 6 characters.");
  getDb().update(schema.users).set({ passcodeHash: hashPasscode(next) }).where(eq(schema.users.id, userId)).run();
  // Invalidate other sessions
  getDb().delete(schema.authSessions).where(eq(schema.authSessions.userId, userId)).run();
}

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- login throttling (in-memory, per client key) ---
const failures = new Map<string, { count: number; until: number }>();

export function checkThrottle(key: string) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) {
    throw new AuthError("throttled", `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.`);
  }
}

function recordFailure(key: string) {
  const f = failures.get(key) ?? { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60_000, 2 ** (f.count - 5) * 30_000);
  failures.set(key, f);
}

export function verifyLogin(passcode: string, throttleKey: string) {
  checkThrottle(throttleKey);
  const owner = getOwner();
  if (!owner?.passcodeHash || !verifyPasscode(passcode, owner.passcodeHash)) {
    recordFailure(throttleKey);
    throw new AuthError("bad_passcode", "Incorrect passcode.");
  }
  failures.delete(throttleKey);
  return owner;
}

export function createSession(userId: string, userAgent?: string | null) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.sessionDays * DAY).toISOString();
  getDb()
    .insert(schema.authSessions)
    .values({ id: sha256(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) })
    .run();
  return { token, expiresAt };
}

export function sessionCookieOptions(expiresAt: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.secureCookies,
    path: "/",
    expires: new Date(expiresAt),
  };
}

export function destroySession(token: string) {
  getDb().delete(schema.authSessions).where(eq(schema.authSessions.id, sha256(token))).run();
}

export function pruneSessions() {
  getDb().delete(schema.authSessions).where(lt(schema.authSessions.expiresAt, new Date().toISOString())).run();
}

export function userFromSessionToken(token: string | undefined): CurrentUser | null {
  if (!token) return null;
  const row = getDb()
    .select({ id: schema.users.id, name: schema.users.name, sid: schema.authSessions.id })
    .from(schema.authSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.authSessions.userId))
    .where(and(eq(schema.authSessions.id, sha256(token)), gt(schema.authSessions.expiresAt, new Date().toISOString())))
    .get();
  if (!row) return null;
  return { id: row.id, name: row.name, via: "session" };
}

/** Proxy mode: trust the identity header from the authenticating reverse proxy. */
export function userFromProxyHeader(value: string | null | undefined): CurrentUser | null {
  if (!value) return null;
  const username = value.trim();
  const allow = config.authProxyUsers;
  if (allow.length && !allow.includes(username)) return null;
  let owner = getOwner();
  if (!owner) {
    getDb().insert(schema.users).values({ id: newId("usr"), name: username }).run();
    owner = getOwner()!;
  }
  // Single-household model: every allowed proxy identity maps to the owner record.
  return { id: owner.id, name: owner.name, via: "proxy" };
}

export function resolveUser(h: Headers, cookieValue: string | undefined): CurrentUser | null {
  if (config.authMode === "proxy") return userFromProxyHeader(h.get(config.authProxyHeader));
  return userFromSessionToken(cookieValue);
}

/** For server components / layouts. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return resolveUser(h, c.get(SESSION_COOKIE)?.value);
}
