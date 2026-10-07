import "server-only";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { config } from "@/server/config";
import { getDb, schema } from "@/server/db";
import { hashPasscode, newId, randomToken, safeEqual, sha256, verifyPasscode } from "@/server/crypto";
import { getSetting, setSetting } from "@/server/settings";
import { DAY } from "@/lib/time";
import { processSingleton } from "@/server/singleton";
import { deviceFromToken } from "@/server/devices";
import { asRole, capabilitiesFor } from "@/server/access";
import type { Role } from "@/lib/modules";

export const SESSION_COOKIE = "jarvis_session";

export type CurrentUser = {
  id: string;
  name: string;
  role: Role;
  /** role defaults + per-person grants (server/access.ts) */
  capabilities: Set<string>;
  via: "session" | "proxy" | "device";
  deviceId?: string;
};

type UserRow = typeof schema.users.$inferSelect;

function toCurrentUser(row: Pick<UserRow, "id" | "name" | "role">, via: CurrentUser["via"], deviceId?: string): CurrentUser {
  const role = asRole(row.role);
  return { id: row.id, name: row.name, role, capabilities: capabilitiesFor(row.id, role), via, ...(deviceId ? { deviceId } : {}) };
}

/** The person who claimed this instance (the first admin). */
export function getOwner() {
  return getDb().select().from(schema.users).where(eq(schema.users.role, "admin")).orderBy(asc(schema.users.createdAt)).limit(1).get();
}

export function getUser(id: string) {
  return getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
}

/** Load a person as a request identity (e.g. for background work done on their behalf). */
export function userById(id: string, via: CurrentUser["via"] = "session"): CurrentUser | null {
  const row = getUser(id);
  return row && !row.disabledAt ? toCurrentUser(row, via) : null;
}

export function normalizeUsername(v: string) {
  return v.trim().toLowerCase();
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
    code = randomToken(6)
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 8)
      .toUpperCase();
    setSetting("setup_code", code);
  }
  return code;
}

export function logSetupCodeIfUnclaimed() {
  if (config.authMode === "local" && !isClaimed()) {
    console.log(`\n[jarvis] Instance not yet claimed. Setup code: ${getSetupCode()}\n[jarvis] Open the app and enter this code to finish onboarding.\n`);
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
    .values({ id, name: input.name.trim() || "Owner", role: "admin", passcodeHash: hashPasscode(input.passcode) })
    .run();
  return id;
}

export function changePasscode(userId: string, current: string, next: string) {
  const user = getDb().select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.passcodeHash || !verifyPasscode(current, user.passcodeHash)) {
    throw new AuthError("bad_passcode", "Current passcode is incorrect.");
  }
  assertPasscodeStrength(next, asRole(user.role));
  getDb()
    .update(schema.users)
    .set({ passcodeHash: hashPasscode(next) })
    .where(eq(schema.users.id, userId))
    .run();
  // Invalidate other sessions
  getDb().delete(schema.authSessions).where(eq(schema.authSessions.userId, userId)).run();
}

/** Household tablets may use a 4+ digit PIN; everyone else needs 6+ characters. */
export function assertPasscodeStrength(passcode: string, role: Role) {
  if (role === "household" && /^\d{4,}$/.test(passcode)) return;
  if (passcode.length < 6)
    throw new AuthError("weak_passcode", role === "household" ? "Use a PIN of at least 4 digits, or 6+ characters." : "Use at least 6 characters.");
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
const failures = processSingleton("login_failures", () => new Map<string, { count: number; until: number }>());

export function checkThrottle(key: string) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) {
    throw new AuthError("throttled", `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.`);
  }
}

export function recordFailure(key: string) {
  const f = failures.get(key) ?? { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60_000, 2 ** (f.count - 5) * 30_000);
  failures.set(key, f);
}

/**
 * Sign in by name + passcode. With no name, the passcode is checked against
 * the owner only (the single-person setup keeps its passcode-only sign-in).
 */
export function verifyLogin(passcode: string, throttleKey: string, username?: string) {
  checkThrottle(throttleKey);
  const name = username ? normalizeUsername(username) : "";
  const user = name
    ? getDb()
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.username, name), isNull(schema.users.disabledAt)))
        .get()
    : getOwner();
  if (!user?.passcodeHash || user.disabledAt || !verifyPasscode(passcode, user.passcodeHash)) {
    recordFailure(throttleKey);
    throw new AuthError("bad_passcode", name ? "Incorrect name or passcode." : "Incorrect passcode.");
  }
  failures.delete(throttleKey);
  return user;
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
  getDb()
    .delete(schema.authSessions)
    .where(eq(schema.authSessions.id, sha256(token)))
    .run();
}

export function pruneSessions() {
  getDb().delete(schema.authSessions).where(lt(schema.authSessions.expiresAt, new Date().toISOString())).run();
}

export function userFromSessionToken(token: string | undefined): CurrentUser | null {
  if (!token) return null;
  const row = getDb()
    .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role })
    .from(schema.authSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.authSessions.userId))
    .where(and(eq(schema.authSessions.id, sha256(token)), gt(schema.authSessions.expiresAt, new Date().toISOString()), isNull(schema.users.disabledAt)))
    .get();
  if (!row) return null;
  return toCurrentUser(row, "session");
}

/** Proxy mode: trust the identity header from the authenticating reverse proxy. */
export function userFromProxyHeader(value: string | null | undefined): CurrentUser | null {
  if (!value) return null;
  const username = normalizeUsername(value);
  const allow = config.authProxyUsers.map(normalizeUsername);
  if (!username || (allow.length && !allow.includes(username))) return null;
  const db = getDb();
  const known = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (known) return known.disabledAt ? null : toCurrentUser(known, "proxy");
  const owner = getOwner();
  if (!owner) {
    // First identity through the proxy becomes the admin.
    const id = newId("usr");
    db.insert(schema.users).values({ id, name: value.trim(), username, role: "admin" }).run();
    return userById(id, "proxy");
  }
  if (!owner.username) {
    // Upgrade from the single-person model: the owner adopts their proxy name.
    db.update(schema.users).set({ username }).where(eq(schema.users.id, owner.id)).run();
    return toCurrentUser(owner, "proxy");
  }
  // Anyone else must be added in Settings → People (with this sign-in name) first.
  return null;
}

/** `Authorization: Bearer jdv_…` from a paired phone, in any auth mode. */
export function bearerToken(h: Headers) {
  const v = h.get("authorization");
  return v?.startsWith("Bearer ") ? v.slice(7).trim() : undefined;
}

export function userFromDeviceToken(token: string): CurrentUser | null {
  const d = deviceFromToken(token);
  if (!d) return null;
  const u = getUser(d.userId);
  return u && !u.disabledAt ? toCurrentUser(u, "device", d.id) : null;
}

export function resolveUser(h: Headers, cookieValue: string | undefined): CurrentUser | null {
  const bearer = bearerToken(h);
  // A bearer request is judged on its token alone: never fall back to cookies.
  if (bearer !== undefined) return userFromDeviceToken(bearer);
  if (config.authMode === "proxy") return userFromProxyHeader(h.get(config.authProxyHeader));
  return userFromSessionToken(cookieValue);
}

/** For server components / layouts. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return resolveUser(h, c.get(SESSION_COOKIE)?.value);
}
