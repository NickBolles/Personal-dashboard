import "server-only";
import crypto from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { hashPasscode, newId, sha256 } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { assertPasscodeStrength, AuthError, getOwner, normalizeUsername } from "@/server/auth";
import { asRole, capabilitiesFor, setCapabilities } from "@/server/access";
import type { Role } from "@/lib/modules";
import { DAY } from "@/lib/time";
import type { Person } from "@/lib/people";

/**
 * People in the household (Settings → People). The admin adds someone with a
 * role, then either hands them a one-time invite link (they choose their own
 * passcode) or sets a PIN directly (the kitchen tablet). Capabilities start at
 * the role's defaults and can be adjusted per person.
 */
const INVITE_TTL_MS = 7 * DAY;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

function code() {
  return [...crypto.randomBytes(10)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function isMultiPerson() {
  const r = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.users)
    .where(isNull(schema.users.disabledAt))
    .get();
  return Number(r?.n ?? 0) > 1;
}

export function listPeople(): Person[] {
  const db = getDb();
  const owner = getOwner()?.id;
  const users = db.select().from(schema.users).orderBy(asc(schema.users.createdAt)).all();
  const overrides = db.select().from(schema.userCapabilities).all();
  const invites = db.select().from(schema.invites).where(isNull(schema.invites.usedAt)).all();
  const devices = db
    .select({ userId: schema.devices.userId, n: sql<number>`count(*)` })
    .from(schema.devices)
    .where(isNull(schema.devices.revokedAt))
    .groupBy(schema.devices.userId)
    .all();
  const now = new Date().toISOString();
  return users.map((u) => {
    const role = asRole(u.role);
    const invite = invites.find((i) => i.userId === u.id && i.expiresAt > now);
    return {
      id: u.id,
      name: u.name,
      username: u.username ?? undefined,
      role,
      owner: u.id === owner,
      disabled: Boolean(u.disabledAt),
      hasPasscode: Boolean(u.passcodeHash),
      inviteExpiresAt: invite?.expiresAt,
      capabilities: [...capabilitiesFor(u.id, role)].sort(),
      overrides: Object.fromEntries(overrides.filter((o) => o.userId === u.id).map((o) => [o.capability, o.granted])),
      phones: Number(devices.find((d) => d.userId === u.id)?.n ?? 0),
      createdAt: u.createdAt,
    };
  });
}

function assertUsername(username: string, exceptId?: string) {
  if (!USERNAME.test(username)) throw new HttpError(400, "bad_username", "Sign-in names use 2–32 letters, numbers, dots, dashes or underscores.");
  const taken = getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).get();
  if (taken && taken.id !== exceptId) throw new HttpError(409, "username_taken", "Someone already uses that sign-in name.");
}

export function createInvite(userId: string, createdBy: string) {
  const c = code();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const db = getDb();
  db.transaction((tx) => {
    // Only the newest invite works.
    tx.delete(schema.invites)
      .where(and(eq(schema.invites.userId, userId), isNull(schema.invites.usedAt)))
      .run();
    tx.insert(schema.invites)
      .values({ codeHash: sha256(c), userId, createdBy, expiresAt })
      .run();
  });
  return { code: `${c.slice(0, 5)}-${c.slice(5)}`, expiresAt };
}

export function createPerson(input: { name: string; username: string; role: Role; passcode?: string }, createdBy: string) {
  const username = normalizeUsername(input.username);
  assertUsername(username);
  if (input.passcode) assertPasscodeStrength(input.passcode, input.role);
  const id = newId("usr");
  getDb()
    .insert(schema.users)
    .values({ id, name: input.name.trim(), username, role: input.role, passcodeHash: input.passcode ? hashPasscode(input.passcode) : null })
    .run();
  const invite = input.passcode ? undefined : createInvite(id, createdBy);
  return { id, invite };
}

function adminsLeft(exceptId: string) {
  return getDb()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, "admin"), isNull(schema.users.disabledAt)))
    .all()
    .filter((u) => u.id !== exceptId).length;
}

export type PersonPatch = {
  name?: string;
  username?: string;
  role?: Role;
  disabled?: boolean;
  passcode?: string;
  capabilities?: Record<string, boolean>;
};

export function updatePerson(id: string, patch: PersonPatch, actorId: string) {
  const db = getDb();
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) throw new HttpError(404, "not_found", "Person not found");
  const role = patch.role ?? asRole(user.role);
  const losesAdmin = (patch.role && patch.role !== "admin") || patch.disabled;
  if (user.role === "admin" && losesAdmin && adminsLeft(id) === 0) {
    throw new HttpError(409, "last_admin", "Jarvis needs at least one admin.");
  }
  if (id === actorId && patch.disabled) throw new HttpError(409, "self", "You can't disable yourself.");
  const set: Partial<typeof schema.users.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.username !== undefined) {
    const u = normalizeUsername(patch.username);
    assertUsername(u, id);
    set.username = u;
  }
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? new Date().toISOString() : null;
  if (patch.passcode) {
    assertPasscodeStrength(patch.passcode, role);
    set.passcodeHash = hashPasscode(patch.passcode);
  }
  db.transaction((tx) => {
    if (Object.keys(set).length) tx.update(schema.users).set(set).where(eq(schema.users.id, id)).run();
    // A new role starts from its own defaults.
    if (patch.role !== undefined && patch.role !== user.role) tx.delete(schema.userCapabilities).where(eq(schema.userCapabilities.userId, id)).run();
    // Disabling or a new passcode signs them out everywhere, phones included.
    if (patch.disabled || patch.passcode) {
      tx.delete(schema.authSessions).where(eq(schema.authSessions.userId, id)).run();
    }
    if (patch.disabled) {
      tx.update(schema.devices)
        .set({ revokedAt: new Date().toISOString() })
        .where(and(eq(schema.devices.userId, id), isNull(schema.devices.revokedAt)))
        .run();
    }
  });
  if (patch.capabilities) setCapabilities(id, patch.capabilities, role);
  return listPeople().find((p) => p.id === id)!;
}

export function deletePerson(id: string, actorId: string) {
  if (id === actorId) throw new HttpError(409, "self", "You can't remove yourself.");
  if (id === getOwner()?.id) throw new HttpError(409, "owner", "The person who set up Jarvis can't be removed. Disable them instead.");
  const user = getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) throw new HttpError(404, "not_found", "Person not found");
  if (user.role === "admin" && adminsLeft(id) === 0) throw new HttpError(409, "last_admin", "Jarvis needs at least one admin.");
  getDb().delete(schema.users).where(eq(schema.users.id, id)).run();
}

export function invitePreview(rawCode: string) {
  const row = validInvite(rawCode);
  const u = row && getDb().select().from(schema.users).where(eq(schema.users.id, row.userId)).get();
  return u && !u.disabledAt ? { name: u.name, username: u.username ?? "", role: asRole(u.role) } : undefined;
}

function validInvite(rawCode: string) {
  const row = getDb()
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.codeHash, sha256(normalizeCode(rawCode))))
    .get();
  return row && !row.usedAt && row.expiresAt > new Date().toISOString() ? row : undefined;
}

/** Accept an invite: the person chooses their own passcode. Single use. */
export function redeemInvite(rawCode: string, passcode: string) {
  const row = validInvite(rawCode);
  const user = row && getDb().select().from(schema.users).where(eq(schema.users.id, row.userId)).get();
  if (!row || !user || user.disabledAt) throw new AuthError("bad_invite", "That invite is wrong, used or expired. Ask for a new one.");
  assertPasscodeStrength(passcode, asRole(user.role));
  getDb().transaction((tx) => {
    tx.update(schema.invites).set({ usedAt: new Date().toISOString() }).where(eq(schema.invites.codeHash, row.codeHash)).run();
    tx.update(schema.users)
      .set({ passcodeHash: hashPasscode(passcode) })
      .where(eq(schema.users.id, user.id))
      .run();
  });
  return user;
}
