import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, getSqlite, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { processSingleton } from "@/server/singleton";
import { INTEGRATIONS, getIntegrationDef, type IntegrationKind } from "@/integrations/registry";
import { saveIntegration } from "@/integrations/store";

export const MAX_CONFIG_FILE_BYTES = 128 * 1024;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const N = 131072;
const r = 8;
const p = 1;
const badFile = () => new HttpError(400, "invalid_configuration", "Invalid configuration file or password");
const value = z.string().max(4000);
const entrySchema = z
  .strictObject({
    kind: z.enum(INTEGRATIONS.map((d) => d.kind) as [IntegrationKind, ...IntegrationKind[]]),
    config: z.record(z.string().max(80), value),
    secrets: z.record(z.string().max(80), value),
  })
  .superRefine((entry, ctx) => {
    const def = getIntegrationDef(entry.kind)!;
    for (const [key, v] of Object.entries(entry.config)) {
      const field = def.fields.find((f) => f.key === key && f.type !== "secret");
      let valid = Boolean(field);
      if (field && v !== "") {
        if (field.type === "select") valid = Boolean(field.options?.some((o) => o.value === v));
        if (field.type === "time") valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
        if (field.type === "number") valid = /^\d+$/.test(v) && Number(v) <= 86400;
        if (field.type === "boolean") valid = v === "true" || v === "false";
        if (field.type === "url") {
          try {
            const url = new URL(v);
            valid = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
          } catch {
            valid = false;
          }
        }
      }
      if (!valid) ctx.addIssue({ code: "custom", message: "Invalid configuration field" });
    }
    for (const key of Object.keys(entry.secrets)) {
      if (!def.fields.some((f) => f.key === key && f.type === "secret")) ctx.addIssue({ code: "custom", message: "Invalid secret field" });
    }
  });
const payloadSchema = z
  .strictObject({ version: z.literal(1), integrations: z.array(entrySchema).max(INTEGRATIONS.length) })
  .refine((data) => new Set(data.integrations.map((e) => e.kind)).size === data.integrations.length);
export type Configuration = z.infer<typeof payloadSchema>;

function validated(data: unknown): Configuration {
  const parsed = payloadSchema.safeParse(data);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_PLAINTEXT_BYTES) throw badFile();
  return parsed.data;
}
const b64 = (bytes: number) => z.string().refine((s) => Buffer.from(s, "base64").length === bytes && Buffer.from(s, "base64").toString("base64") === s);
const envelopeSchema = z.strictObject({
  format: z.literal("jarvis-configuration"),
  version: z.literal(1),
  cipher: z.literal("aes-256-gcm"),
  kdf: z.literal("scrypt"),
  N: z.literal(N),
  r: z.literal(r),
  p: z.literal(p),
  salt: b64(32),
  nonce: b64(12),
  tag: b64(16),
  ciphertext: z.string().min(4).max(90000),
});
function metadata(salt: string, nonce: string) {
  return { format: "jarvis-configuration" as const, version: 1 as const, cipher: "aes-256-gcm" as const, kdf: "scrypt" as const, N, r, p, salt, nonce };
}

/** One bounded asynchronous KDF per process; no attacker-controlled cost or queue. */
async function withKey<T>(password: string, salt: Buffer, run: (key: Buffer) => T): Promise<T> {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024) throw badFile();
  const lock = processSingleton("configurationKdf", () => ({ busy: false }));
  if (lock.busy) throw new HttpError(429, "configuration_busy", "Another configuration operation is running. Try again shortly.");
  lock.busy = true;
  let key: Buffer | undefined;
  try {
    key = await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, salt, 32, { N, r, p, maxmem: 192 * 1024 * 1024 }, (error, derived) => (error ? reject(error) : resolve(derived))),
    );
    return run(key);
  } finally {
    key?.fill(0);
    lock.busy = false;
  }
}

export async function encryptConfiguration(data: unknown, password: string): Promise<string> {
  const payload = validated(data);
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const header = metadata(salt.toString("base64"), nonce.toString("base64"));
  return withKey(password, salt, (key) => {
    const plaintext = Buffer.from(JSON.stringify(payload));
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(header)));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
      return JSON.stringify({ ...header, tag: cipher.getAuthTag().toString("base64"), ciphertext });
    } finally {
      plaintext.fill(0);
    }
  });
}

export async function decryptConfiguration(file: string, password: string): Promise<Configuration> {
  try {
    if (typeof file !== "string" || Buffer.byteLength(file) > MAX_CONFIG_FILE_BYTES) throw badFile();
    const envelope = envelopeSchema.parse(JSON.parse(file));
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (ciphertext.length > MAX_PLAINTEXT_BYTES || ciphertext.toString("base64") !== envelope.ciphertext) throw badFile();
    return await withKey(password, Buffer.from(envelope.salt, "base64"), (key) => {
      const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
      cipher.setAAD(Buffer.from(JSON.stringify(metadata(envelope.salt, envelope.nonce))));
      cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
      try {
        return validated(JSON.parse(plaintext.toString("utf8")));
      } finally {
        plaintext.fill(0);
      }
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) throw error;
    throw badFile();
  }
}

/** Stored fields only. Never export deployment environment, settings tables or runtime state. */
export async function exportConfiguration(password: string, includeSecrets = false) {
  const integrations = getDb()
    .select()
    .from(schema.integrations)
    .all()
    .flatMap((row) => {
      const def = getIntegrationDef(row.kind);
      if (!def) return [];
      const stored = JSON.parse(row.config) as Record<string, unknown>;
      const config = Object.fromEntries(
        def.fields.filter((f) => f.type !== "secret" && stored[f.key] !== undefined).map((f) => [f.key, String(stored[f.key])]),
      );
      const raw = includeSecrets && row.secrets ? (JSON.parse(decrypt(row.secrets)) as Record<string, string>) : {};
      const secrets = Object.fromEntries(def.fields.filter((f) => f.type === "secret" && raw[f.key] !== undefined).map((f) => [f.key, raw[f.key]]));
      return [{ kind: def.kind, config, secrets }];
    });
  return encryptConfiguration({ version: 1, integrations }, password);
}

function currentState() {
  const rows = getDb()
    .select()
    .from(schema.integrations)
    .all()
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const envKinds = INTEGRATIONS.filter((d) => d.fields.some((f) => f.env && Boolean(process.env[f.env]))).map((d) => d.kind);
  const revision = createHash("sha256").update(JSON.stringify({ rows, envKinds })).digest("hex");
  return { rows, envKinds, revision };
}

/** Bind consent to the complete validated import, mode and destination. HMAC avoids
 * exposing a reusable plain hash of low-entropy secrets. Restart requires re-preview.
 * Entry and record-key ordering have no import semantics, so canonicalize both. */
function previewRevision(data: Configuration, replaceExisting: boolean, destination: string) {
  const sorted = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  const payload = {
    version: data.version,
    integrations: [...data.integrations]
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((entry) => ({
        kind: entry.kind,
        config: sorted(entry.config),
        secrets: sorted(entry.secrets),
      })),
  };
  const key = processSingleton("configurationPreviewKey", () => randomBytes(32));
  return createHmac("sha256", key).update(JSON.stringify({ payload, replaceExisting, destination })).digest("hex");
}

/** Preview intentionally contains no imported values, URLs, prompts or secrets. */
export function previewConfiguration(input: Configuration, replaceExisting: boolean) {
  const data = validated(input);
  const state = currentState();
  return {
    revision: previewRevision(data, replaceExisting, state.revision),
    entries: data.integrations.map((entry) => {
      const exists = state.rows.some((row) => row.kind === entry.kind) || state.envKinds.includes(entry.kind);
      const def = getIntegrationDef(entry.kind)!;
      return {
        kind: entry.kind,
        label: def.label,
        fields: Object.keys(entry.config).length,
        secrets: Object.keys(entry.secrets).length,
        action: exists ? (replaceExisting ? ("replace" as const) : ("preserve" as const)) : ("add" as const),
        environmentOverrides: state.envKinds.includes(entry.kind),
      };
    }),
  };
}

/** Synchronous SQLite transaction: same connection as saveIntegration; never call upstreams. */
export function applyConfiguration(input: Configuration, replaceExisting: boolean, revision: string) {
  const data = validated(input);
  return getSqlite()
    .transaction(() => {
      const preview = previewConfiguration(data, replaceExisting);
      if (preview.revision !== revision) throw new HttpError(409, "configuration_changed", "Configuration changed. Preview the file again before applying.");
      let applied = 0;
      for (const entry of data.integrations) {
        if (preview.entries.find((e) => e.kind === entry.kind)!.action === "preserve") continue;
        // Whole-entry replacement: omitted fields/secrets are removed, never silently carried over.
        getDb().delete(schema.integrations).where(eq(schema.integrations.kind, entry.kind)).run();
        saveIntegration(entry.kind, { enabled: false, config: entry.config, secrets: entry.secrets });
        if (entry.kind === "finance") getDb().delete(schema.settings).where(eq(schema.settings.key, "finance_monarch_validated")).run();
        applied++;
      }
      return { applied, preserved: data.integrations.length - applied };
    })
    .immediate();
}
