import "server-only";
import { z } from "zod";
import { upstream } from "@/server/http/fetch";
import { UpstreamError } from "@/server/http/errors";
import { resolveIntegration, saveIntegration } from "@/integrations/store";
import { sha256 } from "@/server/crypto";
import { config } from "@/server/config";
import { processSingleton } from "@/server/singleton";

export const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

export const googleTaskSchema = z
  .object({
    id: z.string(),
    title: z.string().default(""),
    notes: z.string().optional(),
    status: z.enum(["needsAction", "completed"]),
    due: z.string().optional(),
    updated: z.string().optional(),
    completed: z.string().optional(),
    webViewLink: z.string().optional(),
    parent: z.string().optional(),
    deleted: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .passthrough();
export type GoogleTask = z.infer<typeof googleTaskSchema>;

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().default(3600),
  refresh_token: z.string().optional(),
});

type Cached = { token: string; expiresAt: number };
const cache = processSingleton("google_token_cache", () => new Map<string, Cached>());

function settings() {
  const r = resolveIntegration("todos");
  return {
    clientId: r.config.clientId,
    clientSecret: r.secrets.clientSecret,
    refreshToken: r.secrets.refreshToken,
    taskListId: r.config.taskListId || "@default",
    apiBase: r.config.apiBase || "https://tasks.googleapis.com",
    tokenUrl: r.config.tokenUrl || "https://oauth2.googleapis.com/token",
    authUrl: r.config.authUrl || "https://accounts.google.com/o/oauth2/v2/auth",
  };
}

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
    throw new UpstreamError("Google", "unreachable", `Could not reach Google OAuth (${(err as Error).message})`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const kind = res.status === 400 || res.status === 401 ? "unauthorized" : "bad_response";
    throw new UpstreamError("Google", kind, `Google OAuth: ${String(body.error_description ?? body.error ?? res.status)}`, res.status);
  }
  return tokenSchema.parse(body);
}

export async function accessToken(): Promise<string> {
  const s = settings();
  if (!s.clientId || !s.clientSecret) throw new UpstreamError("Google Tasks", "unsupported", "Google OAuth client is not configured");
  if (!s.refreshToken) throw new UpstreamError("Google Tasks", "unauthorized", "Connect your Google account first");
  const key = sha256(s.refreshToken);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const t = await postForm(s.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: s.refreshToken,
    client_id: s.clientId,
    client_secret: s.clientSecret,
  });
  cache.set(key, { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

export function authorizationUrl(redirectUri: string, state: string) {
  const s = settings();
  const u = new URL(s.authUrl);
  u.searchParams.set("client_id", s.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_TASKS_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(code: string, redirectUri: string) {
  const s = settings();
  const t = await postForm(s.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: s.clientId,
    client_secret: s.clientSecret,
  });
  if (!t.refresh_token)
    throw new UpstreamError(
      "Google",
      "bad_response",
      "Google did not return a refresh token. Remove Jarvis from your Google account's third-party access and try again.",
    );
  saveIntegration("todos", { enabled: true, config: { provider: "google_tasks" }, secrets: { refreshToken: t.refresh_token } });
  cache.clear();
}

async function api<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}) {
  const s = settings();
  const token = await accessToken();
  return upstream<T>({
    source: "Google Tasks",
    baseUrl: s.apiBase,
    path,
    method: init.method,
    body: init.body,
    query: init.query,
    headers: { authorization: `Bearer ${token}` },
  });
}

export const GoogleTasksClient = {
  lists: async () => {
    const r = await api<{ items?: { id: string; title: string }[] }>("/tasks/v1/users/@me/lists");
    return r.items ?? [];
  },
  tasks: async (opts: { completedMin?: string } = {}) => {
    const s = settings();
    const r = await api<{ items?: unknown[] }>(`/tasks/v1/lists/${encodeURIComponent(s.taskListId)}/tasks`, {
      query: {
        showCompleted: "true",
        showHidden: "true",
        maxResults: "100",
        ...(opts.completedMin ? { completedMin: opts.completedMin } : {}),
      },
    });
    return z.array(googleTaskSchema).parse(r.items ?? []);
  },
  get: async (id: string) => {
    const s = settings();
    return googleTaskSchema.parse(await api(`/tasks/v1/lists/${encodeURIComponent(s.taskListId)}/tasks/${encodeURIComponent(id)}`));
  },
  patch: async (id: string, body: Partial<Pick<GoogleTask, "status" | "due" | "title" | "notes">>) => {
    const s = settings();
    return googleTaskSchema.parse(await api(`/tasks/v1/lists/${encodeURIComponent(s.taskListId)}/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body }));
  },
};

export function requestOrigin(req: { headers: Headers; nextUrl: URL }) {
  const host = req.headers.get("x-forwarded-host");
  return host ? `${req.headers.get("x-forwarded-proto") ?? "https"}://${host}` : req.nextUrl.origin;
}

export function googleRedirectUri(origin: string) {
  return `${config.publicOrigin ?? origin}/api/integrations/todos/oauth/callback`;
}
