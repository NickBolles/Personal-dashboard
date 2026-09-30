import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { getIntegrationDef, INTEGRATIONS, withDefaults, type IntegrationKind, type PublicIntegration, type TestResult } from "./registry";

export type ResolvedIntegration = {
  kind: IntegrationKind;
  enabled: boolean;
  /** non-secret config with defaults and env overrides applied */
  config: Record<string, string>;
  /** decrypted secrets with env overrides applied (server only!) */
  secrets: Record<string, string>;
  envManaged: string[];
};

function row(kind: IntegrationKind) {
  return getDb().select().from(schema.integrations).where(eq(schema.integrations.kind, kind)).get();
}

function readSecrets(cipher: string | null | undefined): Record<string, string> {
  if (!cipher) return {};
  try {
    return JSON.parse(decrypt(cipher)) as Record<string, string>;
  } catch (err) {
    console.error("[jarvis] could not decrypt integration secrets (was the secret key changed?)", (err as Error).message);
    return {};
  }
}

export function resolveIntegration(kind: IntegrationKind): ResolvedIntegration {
  const def = getIntegrationDef(kind);
  if (!def) throw new Error(`Unknown integration ${kind}`);
  const r = row(kind);
  const stored = r ? (JSON.parse(r.config) as Record<string, unknown>) : {};
  const secrets = readSecrets(r?.secrets);
  const envManaged: string[] = [];
  for (const f of def.fields) {
    const envVal = f.env ? process.env[f.env] : undefined;
    if (envVal !== undefined && envVal !== "") {
      envManaged.push(f.key);
      if (f.type === "secret") secrets[f.key] = envVal;
      else stored[f.key] = envVal;
    }
  }
  const cfg = withDefaults(def, stored);
  // An integration configured purely via env counts as enabled.
  const envEnabled = def.fields.some((f) => f.required && envManaged.includes(f.key));
  return {
    kind,
    enabled: r ? r.enabled : envEnabled,
    config: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, String(v ?? "")])),
    secrets,
    envManaged,
  };
}

/** Enabled and minimally configured. */
export function isConfigured(kind: IntegrationKind) {
  const r = resolveIntegration(kind);
  if (!r.enabled) return false;
  const def = getIntegrationDef(kind)!;
  return def.fields.every((f) => !f.required || Boolean(f.type === "secret" ? r.secrets[f.key] : r.config[f.key]));
}

export function publicIntegration(kind: IntegrationKind): PublicIntegration {
  const def = getIntegrationDef(kind)!;
  const r = resolveIntegration(kind);
  const stored = row(kind);
  return {
    kind,
    enabled: r.enabled,
    config: r.config,
    secrets: Object.fromEntries(
      def.fields.filter((f) => f.type === "secret").map((f) => [f.key, { set: Boolean(r.secrets[f.key]), fromEnv: r.envManaged.includes(f.key) }]),
    ),
    envManaged: r.envManaged,
    lastTest: stored?.lastTestResult ? (JSON.parse(stored.lastTestResult) as TestResult) : undefined,
  };
}

export function listPublicIntegrations() {
  return INTEGRATIONS.map((d) => publicIntegration(d.kind));
}

export type IntegrationUpdate = {
  enabled?: boolean;
  config?: Record<string, string | number | boolean>;
  /** value = new secret, null = clear, undefined/absent = unchanged */
  secrets?: Record<string, string | null>;
};

export function saveIntegration(kind: IntegrationKind, update: IntegrationUpdate) {
  const def = getIntegrationDef(kind);
  if (!def) throw new Error(`Unknown integration ${kind}`);
  const r = row(kind);
  const config = r ? (JSON.parse(r.config) as Record<string, unknown>) : {};
  const secrets = readSecrets(r?.secrets);
  const allowedConfig = new Set(def.fields.filter((f) => f.type !== "secret").map((f) => f.key));
  const allowedSecrets = new Set(def.fields.filter((f) => f.type === "secret").map((f) => f.key));
  for (const [k, v] of Object.entries(update.config ?? {})) {
    if (allowedConfig.has(k)) config[k] = typeof v === "string" ? v.trim() : v;
  }
  for (const [k, v] of Object.entries(update.secrets ?? {})) {
    if (!allowedSecrets.has(k)) continue;
    if (v === null || v === "") delete secrets[k];
    else if (typeof v === "string") secrets[k] = v.trim();
  }
  const values = {
    kind,
    enabled: update.enabled ?? r?.enabled ?? true,
    config: JSON.stringify(config),
    secrets: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null,
    updatedAt: new Date().toISOString(),
  };
  getDb().insert(schema.integrations).values(values).onConflictDoUpdate({ target: schema.integrations.kind, set: values }).run();
  return publicIntegration(kind);
}

export function recordTestResult(kind: IntegrationKind, result: TestResult) {
  const existing = row(kind);
  if (!existing) {
    getDb().insert(schema.integrations).values({ kind, enabled: false }).run();
  }
  getDb()
    .update(schema.integrations)
    .set({ lastTestAt: result.checkedAt, lastTestOk: result.ok, lastTestResult: JSON.stringify(result) })
    .where(eq(schema.integrations.kind, kind))
    .run();
}
