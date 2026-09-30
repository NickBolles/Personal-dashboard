import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "@/server/config";

/**
 * AES-256-GCM envelope for integration secrets stored in SQLite.
 * Key source: JARVIS_SECRET_KEY (base64, 32 bytes) or a generated key file
 * (<dataDir>/secret.key, mode 0600). Back the key up separately from the DB.
 */
let cachedKey: Buffer | undefined;

export function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = config.secretKey;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) throw new Error("JARVIS_SECRET_KEY must be 32 bytes, base64 encoded");
    cachedKey = buf;
    return buf;
  }
  const file = path.join(config.dataDir, "secret.key");
  if (fs.existsSync(file)) {
    cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  } else {
    fs.mkdirSync(config.dataDir, { recursive: true });
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(file, cachedKey.toString("base64"), { mode: 0o600 });
  }
  return cachedKey;
}

export function __resetKeyCache() {
  cachedKey = undefined;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [v, iv, tag, data] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function newId(prefix?: string) {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

const SCRYPT_N = 16384;

export function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(passcode, salt, 64, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPasscode(passcode: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(passcode, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
  });
  return crypto.timingSafeEqual(expected, actual);
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
