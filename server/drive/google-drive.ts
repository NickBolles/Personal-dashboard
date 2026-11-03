import "server-only";
import { z } from "zod";
import { UpstreamError, HttpError } from "@/server/http/errors";
import { resolveIntegration } from "@/integrations/store";
import { decrypt, encrypt } from "@/server/crypto";
import { config } from "@/server/config";
import { getSetting, setSetting } from "@/server/settings";
import { processSingleton } from "@/server/singleton";
import { DRIVE_FILE_SCOPE, driveQueryLiteral, driveScopes } from "@/lib/workflows/drive-path";

/**
 * #141 Google Drive connection for workflow exports.
 *
 * - Scope: `drive.file` ONLY (files Jarvis creates; no access to the rest of Drive).
 * - Its own consent ("Connect Drive" in Settings → Connections), never at sign-in,
 *   with `include_granted_scopes` so it composes with any other Google grant.
 * - Behind JARVIS_ENABLE_DRIVE_EXPORT (default OFF) until the owner's Google
 *   OAuth client allows this redirect URI and the Drive API is enabled.
 * - Refresh token stored encrypted in settings (`drive.connection`).
 */

const SETTING = "drive.connection";
const STATE = "drive_oauth_state";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

type Stored = { refreshToken: string; connectedAt: string; scope: string };

export function driveEnabled() {
  return ["1", "true", "yes", "on"].includes((process.env.JARVIS_ENABLE_DRIVE_EXPORT ?? "").toLowerCase());
}

function urls() {
  return {
    api: (process.env.JARVIS_DRIVE_API_URL || "https://www.googleapis.com").replace(/\/$/, ""),
    auth: process.env.JARVIS_DRIVE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    token: process.env.JARVIS_DRIVE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    revoke: process.env.JARVIS_DRIVE_REVOKE_URL || "https://oauth2.googleapis.com/revoke",
  };
}

/** Same Google OAuth client as Google Tasks (env GOOGLE_CLIENT_ID/SECRET or Connections), overridable for Drive. */
function client() {
  const r = resolveIntegration("todos");
  return {
    clientId: process.env.JARVIS_DRIVE_CLIENT_ID || r.config.clientId || "",
    clientSecret: process.env.JARVIS_DRIVE_CLIENT_SECRET || r.secrets.clientSecret || "",
  };
}

function stored(): Stored | null {
  const s = getSetting<{ refreshToken: string; connectedAt: string; scope: string }>(SETTING);
  if (!s?.refreshToken) return null;
  try {
    return { ...s, refreshToken: decrypt(s.refreshToken) };
  } catch {
    return null;
  }
}

export type DriveStatus = { available: boolean; configured: boolean; connected: boolean; connectedAt: string | null; scope: string; redirectPath: string };

export function driveStatus(): DriveStatus {
  const c = client();
  const s = stored();
  return {
    available: driveEnabled(),
    configured: Boolean(c.clientId && c.clientSecret),
    connected: Boolean(s),
    connectedAt: s?.connectedAt ?? null,
    scope: DRIVE_FILE_SCOPE,
    redirectPath: "/api/integrations/drive/oauth/callback",
  };
}

function requireAvailable() {
  if (!driveEnabled()) throw new HttpError(404, "drive_disabled", "Save to Google Drive isn't turned on for this Jarvis");
  const c = client();
  if (!c.clientId || !c.clientSecret) throw new HttpError(409, "drive_not_configured", "No Google OAuth client is configured");
  return c;
}

export function driveRedirectUri(origin: string) {
  return `${config.publicOrigin ?? origin}/api/integrations/drive/oauth/callback`;
}

/** Consent URL: drive.file only, offline, incremental (include_granted_scopes). */
export function driveAuthorizationUrl(redirectUri: string, state: string) {
  const c = requireAvailable();
  const u = new URL(urls().auth);
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", driveScopes().join(" "));
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

export function beginDriveConsent(state: string) {
  setSetting(STATE, { state, at: Date.now() });
}

export function takeDriveConsentState(): { state: string; at: number } | undefined {
  const s = getSetting<{ state: string; at: number }>(STATE);
  setSetting(STATE, null);
  return s ?? undefined;
}

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().default(3600),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

async function postForm(url: string, form: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new UpstreamError("Google Drive", "unreachable", `Could not reach Google (${(err as Error).message})`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const kind = res.status === 400 || res.status === 401 ? "unauthorized" : "bad_response";
    throw new UpstreamError("Google Drive", kind, `Google: ${String(body.error_description ?? body.error ?? res.status)}`, res.status);
  }
  return tokenSchema.parse(body);
}

type Cached = { token: string; expiresAt: number };
const cache = processSingleton("drive_token_cache", () => ({ v: null as Cached | null }));

export async function exchangeDriveCode(code: string, redirectUri: string) {
  const c = requireAvailable();
  const t = await postForm(urls().token, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  if (!t.refresh_token)
    throw new UpstreamError(
      "Google Drive",
      "bad_response",
      "Google did not return a refresh token. Remove Jarvis from your Google account's third-party access and try again.",
    );
  // granted scopes may include earlier grants (include_granted_scopes); we only ever USE drive.file
  if (t.scope && !t.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) throw new UpstreamError("Google Drive", "unauthorized", "Drive access wasn't granted");
  setSetting(SETTING, { refreshToken: encrypt(t.refresh_token), connectedAt: new Date().toISOString(), scope: DRIVE_FILE_SCOPE });
  cache.v = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

/**
 * True when Drive shares its OAuth client with a connected Google Tasks account.
 * With include_granted_scopes the two can be one combined Google grant, and revoking
 * it would also cut off Tasks, so disconnect only forgets Drive's token then.
 */
function sharesGrantWithTasks() {
  if (process.env.JARVIS_DRIVE_CLIENT_ID) return false;
  const r = resolveIntegration("todos");
  return Boolean(r.secrets.refreshToken) && (r.config.provider ?? "google_tasks") === "google_tasks";
}

/** Forget the token (and revoke it at Google, best effort, unless the grant is shared with Tasks). */
export async function disconnectDrive(): Promise<{ revoked: boolean; keptSharedGrant?: boolean }> {
  const s = stored();
  setSetting(SETTING, null);
  cache.v = null;
  if (!s) return { revoked: false };
  if (sharesGrantWithTasks()) return { revoked: false, keptSharedGrant: true };
  try {
    const res = await fetch(urls().revoke, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: s.refreshToken }),
      signal: AbortSignal.timeout(8000),
    });
    return { revoked: res.ok };
  } catch {
    return { revoked: false };
  }
}

async function accessToken() {
  const c = requireAvailable();
  const s = stored();
  if (!s) throw new HttpError(409, "drive_not_connected", "Connect Google Drive in Settings → Connections first");
  if (cache.v && cache.v.expiresAt > Date.now() + 60_000) return cache.v.token;
  const t = await postForm(urls().token, { grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: c.clientId, client_secret: c.clientSecret });
  cache.v = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  return t.access_token;
}

async function driveFetch<T>(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
  const token = await accessToken();
  const u = new URL(urls().api + path);
  for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(u, {
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new UpstreamError("Google Drive", "unreachable", `Could not reach Google Drive (${(err as Error).message})`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String((body.error as { message?: string } | undefined)?.message ?? res.status);
    throw new UpstreamError("Google Drive", res.status === 401 || res.status === 403 ? "unauthorized" : "bad_response", `Google Drive: ${msg}`, res.status);
  }
  return body as T;
}

const fileSchema = z.object({ id: z.string(), name: z.string().optional(), mimeType: z.string().optional(), webViewLink: z.string().optional() });

/** Find-or-create each folder level under My Drive (drive.file only sees folders Jarvis made). */
export async function ensureFolderPath(segments: string[]): Promise<string> {
  let parent = "root";
  for (const name of segments) {
    const q = `name = ${driveQueryLiteral(name)} and mimeType = '${FOLDER_MIME}' and ${driveQueryLiteral(parent)} in parents and trashed = false`;
    const found = await driveFetch<{ files?: unknown[] }>("/drive/v3/files", { query: { q, fields: "files(id,name)", pageSize: "1", spaces: "drive" } });
    const hit = z.array(fileSchema).parse(found.files ?? [])[0];
    if (hit) {
      parent = hit.id;
      continue;
    }
    const made = fileSchema.parse(
      await driveFetch("/drive/v3/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
        query: { fields: "id,name" },
      }),
    );
    parent = made.id;
  }
  return parent;
}

function multipart(meta: object, content: string, contentType: string) {
  const boundary = `jarvis-${Math.random().toString(36).slice(2)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(meta),
    `--${boundary}`,
    `Content-Type: ${contentType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export type DriveSaved = { fileId: string; url: string; name: string; kind: "doc" | "markdown" };

/**
 * Upload the Markdown as a Google Doc (Drive converts text/markdown). If Drive
 * refuses the conversion, fall back to a plain `.md` file.
 */
export async function uploadMarkdown(name: string, markdown: string, parentId: string): Promise<DriveSaved> {
  const up = (meta: object, type: string) => {
    const m = multipart(meta, markdown, type);
    return driveFetch("/upload/drive/v3/files", {
      method: "POST",
      headers: { "content-type": m.contentType },
      body: m.body,
      query: { uploadType: "multipart", fields: "id,name,mimeType,webViewLink" },
    });
  };
  try {
    const f = fileSchema.parse(await up({ name, mimeType: DOC_MIME, parents: [parentId] }, "text/markdown; charset=UTF-8"));
    return { fileId: f.id, name: f.name ?? name, url: f.webViewLink ?? `https://docs.google.com/document/d/${f.id}/edit`, kind: "doc" };
  } catch (err) {
    if (!(err instanceof UpstreamError) || err.status !== 400) throw err;
    const md = `${name}.md`;
    const f = fileSchema.parse(await up({ name: md, mimeType: "text/markdown", parents: [parentId] }, "text/markdown; charset=UTF-8"));
    return { fileId: f.id, name: f.name ?? md, url: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`, kind: "markdown" };
  }
}
