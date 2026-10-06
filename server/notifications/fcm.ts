import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { decrypt, encrypt } from "@/server/crypto";
import { getSetting, setSetting } from "@/server/settings";
import { processSingleton } from "@/server/singleton";
import { getDb, schema } from "@/server/db";
import { eq } from "drizzle-orm";
import { pushDevices } from "@/server/devices";
import type { PushPayload } from "./push";

/**
 * Phone push via Firebase Cloud Messaging (HTTP v1), no Firebase SDK on the
 * server. Configure once in Settings → Phones by pasting the Firebase
 * project's google-services.json (public client config the app needs) and a
 * service-account key (secret, used here to sign OAuth tokens). Env overrides:
 * JARVIS_FCM_GOOGLE_SERVICES(_FILE), JARVIS_FCM_SERVICE_ACCOUNT(_FILE).
 *
 * Messages are data-only so the app builds the notification itself (channels
 * by severity, Acknowledge/Open actions) even when it is in the background.
 */

const serviceAccountSchema = z.object({
  project_id: z.string(),
  client_email: z.string(),
  private_key: z.string(),
  token_uri: z.string().url().default("https://oauth2.googleapis.com/token"),
});
type ServiceAccount = z.infer<typeof serviceAccountSchema>;

const googleServicesSchema = z.object({
  project_info: z.object({ project_number: z.string(), project_id: z.string() }),
  client: z
    .array(
      z.object({
        client_info: z.object({ mobilesdk_app_id: z.string(), android_client_info: z.object({ package_name: z.string() }).optional() }),
        api_key: z.array(z.object({ current_key: z.string() })).min(1),
      }),
    )
    .min(1),
});

/** What the app needs to initialise Firebase at runtime (public values, not secrets). */
export type FcmClientConfig = { projectId: string; applicationId: string; apiKey: string; senderId: string };

const APP_PACKAGE = "com.nickbolles.jarvis";
const SETTING = "fcm_config";
type Stored = { googleServices?: string; serviceAccount?: string /* encrypted */ };

function readEnvOrFile(name: string) {
  const inline = process.env[name];
  if (inline) return inline;
  const file = process.env[`${name}_FILE`];
  return file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

function stored(): Stored {
  return getSetting<Stored>(SETTING) ?? {};
}

export function parseGoogleServices(json: string): FcmClientConfig {
  const g = googleServicesSchema.parse(JSON.parse(json));
  const client = g.client.find((c) => c.client_info.android_client_info?.package_name === APP_PACKAGE) ?? g.client[0]!;
  return {
    projectId: g.project_info.project_id,
    senderId: g.project_info.project_number,
    applicationId: client.client_info.mobilesdk_app_id,
    apiKey: client.api_key[0]!.current_key,
  };
}

export function parseServiceAccount(json: string): ServiceAccount {
  return serviceAccountSchema.parse(JSON.parse(json));
}

export function fcmClientConfig(): FcmClientConfig | null {
  const raw = readEnvOrFile("JARVIS_FCM_GOOGLE_SERVICES") ?? stored().googleServices;
  if (!raw) return null;
  try {
    return parseGoogleServices(raw);
  } catch {
    return null;
  }
}

function serviceAccount(): ServiceAccount | null {
  const env = readEnvOrFile("JARVIS_FCM_SERVICE_ACCOUNT");
  const enc = stored().serviceAccount;
  const raw = env ?? (enc ? decrypt(enc) : undefined);
  if (!raw) return null;
  try {
    return parseServiceAccount(raw);
  } catch {
    return null;
  }
}

export function fcmStatus() {
  const client = fcmClientConfig();
  const sa = serviceAccount();
  return {
    configured: Boolean(client && sa),
    clientConfig: Boolean(client),
    serviceAccount: Boolean(sa),
    projectId: client?.projectId ?? sa?.project_id,
    projectMismatch: Boolean(client && sa && client.projectId !== sa.project_id),
    fromEnv: Boolean(readEnvOrFile("JARVIS_FCM_GOOGLE_SERVICES") || readEnvOrFile("JARVIS_FCM_SERVICE_ACCOUNT")),
  };
}

/** Validates before storing; the service account is encrypted at rest. `null` clears a value. */
export function saveFcmConfig(input: { googleServices?: string | null; serviceAccount?: string | null }) {
  const next = { ...stored() };
  if (input.googleServices !== undefined) {
    if (input.googleServices) parseGoogleServices(input.googleServices);
    next.googleServices = input.googleServices ?? undefined;
  }
  if (input.serviceAccount !== undefined) {
    if (input.serviceAccount) parseServiceAccount(input.serviceAccount);
    next.serviceAccount = input.serviceAccount ? encrypt(input.serviceAccount) : undefined;
  }
  setSetting(SETTING, next);
  accessToken.cache = undefined;
}

/* ------------------------------------------------------------- OAuth token */

const accessToken = processSingleton<{ cache?: { token: string; expiresAt: number; email: string }; pending?: Promise<string> }>("fcm_token", () => ({}));

function signJwt(sa: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  return `${unsigned}.${sig}`;
}

async function getAccessToken(sa: ServiceAccount) {
  const c = accessToken.cache;
  if (c && c.email === sa.client_email && c.expiresAt > Date.now() + 60_000) return c.token;
  accessToken.pending ??= (async () => {
    try {
      const res = await fetch(sa.token_uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(sa) }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
      if (!res.ok || !body.access_token) throw new Error(`Firebase auth failed (${res.status}${body.error_description ? `: ${body.error_description}` : ""})`);
      accessToken.cache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, email: sa.client_email };
      return body.access_token;
    } finally {
      accessToken.pending = undefined;
    }
  })();
  return accessToken.pending;
}

/* ------------------------------------------------------------------- send */

const fcmBase = () => (process.env.JARVIS_FCM_BASE_URL ?? "https://fcm.googleapis.com").replace(/\/$/, "");

/** Data payload the app understands (all values must be strings for FCM). */
export function fcmData(p: PushPayload & { category?: string; unread?: number }) {
  return Object.fromEntries(
    Object.entries({
      type: "notification",
      id: p.id,
      title: p.title,
      body: p.body,
      url: p.url,
      tag: p.tag,
      severity: p.severity,
      category: p.category,
      unread: p.unread,
    })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
}

export async function sendFcmToUser(userId: string, data: Record<string, string>, opts: { urgency?: "high" | "normal" | "low" } = {}) {
  const devices = pushDevices(userId);
  if (!devices.length) return { sent: 0, failed: 0, total: 0 };
  const sa = serviceAccount();
  if (!sa) return { sent: 0, failed: 0, total: 0 };
  let token: string;
  try {
    token = await getAccessToken(sa);
  } catch (err) {
    console.warn(`[jarvis] ${(err as Error).message}`);
    return { sent: 0, failed: devices.length, total: devices.length };
  }
  let sent = 0;
  let failed = 0;
  await Promise.all(
    devices.map(async (d) => {
      try {
        const res = await fetch(`${fcmBase()}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              token: d.pushToken,
              data,
              android: { priority: opts.urgency === "high" ? "HIGH" : "NORMAL", ttl: "43200s", ...(data.tag ? { collapse_key: data.tag.slice(0, 64) } : {}) },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          sent++;
          getDb().update(schema.devices).set({ pushFailures: 0 }).where(eq(schema.devices.id, d.id)).run();
          return;
        }
        failed++;
        const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
        const code = body.error?.details?.find((x) => x.errorCode)?.errorCode ?? body.error?.status;
        // The app was uninstalled or the token rotated: stop sending until the app registers again.
        const dead = res.status === 404 || code === "UNREGISTERED" || (res.status === 400 && code === "INVALID_ARGUMENT");
        getDb()
          .update(schema.devices)
          .set(dead ? { pushToken: null, pushFailures: 0 } : { pushFailures: d.pushFailures + 1 })
          .where(eq(schema.devices.id, d.id))
          .run();
        if (!dead) console.warn(`[jarvis] FCM send failed (${res.status} ${code ?? ""})`);
      } catch {
        failed++;
      }
    }),
  );
  return { sent, failed, total: devices.length };
}
