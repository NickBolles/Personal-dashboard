import "server-only";
import crypto from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId, randomToken, sha256 } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { MINUTE } from "@/lib/time";

/**
 * Native app pairing. Settings shows a short-lived, single-use code (also as a
 * QR code). The phone exchanges it for a long-lived device token, which it
 * sends as `Authorization: Bearer jdv_…`. Tokens are stored hashed and can be
 * revoked from Settings. Bearer requests carry no ambient credentials, so they
 * don't need the browser CSRF header.
 */
export const DEVICE_TOKEN_PREFIX = "jdv_";
const PAIRING_TTL_MS = 10 * MINUTE;
// No 0/O/1/I/L: the code is also typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type DeviceSummary = {
  id: string;
  name: string;
  platform: string;
  appVersion?: string;
  pushEnabled: boolean;
  createdAt: string;
  lastSeenAt: string;
};

function normalizeCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function createPairingCode(userId: string) {
  const bytes = crypto.randomBytes(8);
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const db = getDb();
  // Only the latest code is valid: showing a new QR invalidates older ones.
  db.delete(schema.pairingCodes)
    .where(and(eq(schema.pairingCodes.userId, userId), isNull(schema.pairingCodes.usedAt)))
    .run();
  db.insert(schema.pairingCodes)
    .values({ codeHash: sha256(code), userId, expiresAt })
    .run();
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

export function pairingUri(origin: string, code: string) {
  return `jarvis://pair?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
}

export function redeemPairingCode(code: string, device: { name: string; platform?: string; appVersion?: string }) {
  const db = getDb();
  const hash = sha256(normalizeCode(code));
  const row = db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.codeHash, hash)).get();
  if (!row || row.usedAt || row.expiresAt < new Date().toISOString()) {
    throw new HttpError(400, "bad_pairing_code", "That pairing code is wrong or expired. Show a new one in Settings → Phones.");
  }
  const token = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
  const id = newId("dev");
  db.transaction((tx) => {
    tx.update(schema.pairingCodes).set({ usedAt: new Date().toISOString() }).where(eq(schema.pairingCodes.codeHash, hash)).run();
    tx.insert(schema.devices)
      .values({
        id,
        userId: row.userId,
        name: device.name.trim().slice(0, 80) || "Phone",
        platform: device.platform ?? "android",
        appVersion: device.appVersion?.slice(0, 40),
        tokenHash: sha256(token),
      })
      .run();
  });
  return { token, deviceId: id, userId: row.userId };
}

const SEEN_THROTTLE_MS = 5 * MINUTE;

/** Resolve a bearer device token to its owner. Updates lastSeenAt at most every few minutes. */
export function deviceFromToken(token: string) {
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const db = getDb();
  const row = db
    .select({ id: schema.devices.id, lastSeenAt: schema.devices.lastSeenAt, userId: schema.users.id, name: schema.users.name })
    .from(schema.devices)
    .innerJoin(schema.users, eq(schema.users.id, schema.devices.userId))
    .where(and(eq(schema.devices.tokenHash, sha256(token)), isNull(schema.devices.revokedAt)))
    .get();
  if (!row) return null;
  if (Date.now() - new Date(row.lastSeenAt).getTime() > SEEN_THROTTLE_MS) {
    db.update(schema.devices).set({ lastSeenAt: new Date().toISOString() }).where(eq(schema.devices.id, row.id)).run();
  }
  return row;
}

export function listDevices(userId: string): DeviceSummary[] {
  return getDb()
    .select()
    .from(schema.devices)
    .where(and(eq(schema.devices.userId, userId), isNull(schema.devices.revokedAt)))
    .orderBy(desc(schema.devices.lastSeenAt))
    .all()
    .map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion ?? undefined,
      pushEnabled: Boolean(d.pushToken),
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
    }));
}

export function revokeDevice(userId: string, id: string) {
  const res = getDb()
    .update(schema.devices)
    .set({ revokedAt: new Date().toISOString(), pushToken: null })
    .where(and(eq(schema.devices.id, id), eq(schema.devices.userId, userId), isNull(schema.devices.revokedAt)))
    .run();
  return res.changes > 0;
}

export function updateDevice(id: string, patch: { pushToken?: string | null; appVersion?: string; name?: string }) {
  getDb()
    .update(schema.devices)
    .set({
      ...(patch.pushToken !== undefined ? { pushToken: patch.pushToken, pushFailures: 0 } : {}),
      ...(patch.appVersion ? { appVersion: patch.appVersion.slice(0, 40) } : {}),
      ...(patch.name ? { name: patch.name.trim().slice(0, 80) } : {}),
    })
    .where(eq(schema.devices.id, id))
    .run();
}

export function pushDevices(userId: string) {
  return getDb()
    .select({ id: schema.devices.id, pushToken: schema.devices.pushToken, pushFailures: schema.devices.pushFailures })
    .from(schema.devices)
    .where(and(eq(schema.devices.userId, userId), isNull(schema.devices.revokedAt)))
    .all()
    .filter((d): d is { id: string; pushToken: string; pushFailures: number } => Boolean(d.pushToken));
}
