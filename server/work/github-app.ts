import "server-only";
import { eq, lt } from "drizzle-orm";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { config } from "@/server/config";
import { getDb, schema } from "@/server/db";
import { decrypt, encrypt, newId, randomToken, sha256 } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { SESSION_COOKIE, type CurrentUser } from "@/server/auth";
import { processSingleton } from "@/server/singleton";
import { getSetting, setSetting } from "@/server/settings";
import {
  APP_CALLBACK_PATH,
  appInstallUrl,
  WEBHOOK_PATH,
  type githubAppConnectSchema,
  type githubAppManifestSchema,
  type GithubAppSetup,
  type PublicGithubApp,
  type PublicGithubInstallation,
} from "@/lib/github";
import {
  accountAllowed,
  appJwt,
  buildManifest,
  defaultAllowlist,
  manifestAction,
  pickInstallation,
  STATE_TTL_MS,
  stateProblem,
  tokenFresh,
  type InstallationEvent,
} from "./github-app-rules";
import { githubApiBase, storedConnections, type ResolvedToken } from "./github";

/**
 * The read-only GitHub App (docs/work.md "GitHub App"). Created by the
 * owner's own browser through GitHub's manifest flow (no secrets ever pass
 * through chat): Jarvis builds the manifest and a one-time state, the browser
 * POSTs it to GitHub, the owner confirms there (passkey), GitHub redirects to
 * /api/github/app/callback, and Jarvis exchanges the code for the App's
 * credentials, stored encrypted and never returned. Installations are read
 * with the App JWT; installation tokens (cached until 5 min before expiry)
 * are the first choice for reads. The only non-GET calls Jarvis makes to
 * GitHub are the manifest conversion and minting installation tokens; the
 * App's permissions are read-only.
 */

const A = schema.githubApps;
const I = schema.githubAppInstallations;
const S = schema.githubAppStates;
const ALLOWLIST_KEY = "work.github.app_allowlist";
const REFRESH_KEY = "work.github.app_refresh";
const TIMEOUT_MS = 8000;

// --- origin / setup ---

/** The public origin GitHub should send people and webhooks to. */
export function requestOrigin(req: NextRequest) {
  if (config.publicOrigin) return config.publicOrigin;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

export function appSetup(origin: string, defaultName: string): GithubAppSetup {
  return {
    defaultName,
    origin,
    callbackUrl: `${origin}${APP_CALLBACK_PATH}`,
    webhookUrl: `${origin}${WEBHOOK_PATH}`,
    https: origin.startsWith("https://"),
  };
}

/** The manifest state is bound to this browser session (or the proxy identity). Phones can't run the flow. */
export function sessionKeyFor(req: NextRequest, user: CurrentUser) {
  if (user.via === "proxy") return `proxy:${user.id}`;
  if (user.via !== "session") throw new HttpError(403, "browser_only", "Create the GitHub App from a browser");
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookie) throw new HttpError(403, "browser_only", "Create the GitHub App from a browser");
  return sha256(cookie);
}

// --- stored App ---

export function storedApp() {
  return getDb().select().from(A).limit(1).get() ?? null;
}

function plain(cipher: string | null): string | null {
  if (!cipher) return null;
  try {
    return decrypt(cipher);
  } catch {
    // Never log the value; only that it couldn't be read.
    console.error("[jarvis] could not decrypt a GitHub App secret (was the secret key changed?)");
    return null;
  }
}

/** The App's webhook secret (for X-Hub-Signature-256), if an App with one exists. */
export function appWebhookSecret(): string | null {
  return plain(storedApp()?.webhookSecretCipher ?? null);
}

export function appAllowlist(app = storedApp()): { list: string[]; isDefault: boolean } {
  const stored = getSetting<string[]>(ALLOWLIST_KEY);
  if (Array.isArray(stored)) return { list: [...new Set(stored.map((s) => s.toLowerCase()))], isDefault: false };
  return {
    list: defaultAllowlist(
      storedConnections().map((c) => c.owner),
      app?.ownerLogin,
    ),
    isDefault: true,
  };
}

function parseRepos(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

export function appInstallations() {
  return getDb()
    .select()
    .from(I)
    .orderBy(I.accountKey)
    .all()
    .map((r) => ({ ...r, repos: parseRepos(r.repos) }));
}

/** An App exists with at least one allowlisted, active installation. */
export function appReadEnabled() {
  const app = storedApp();
  if (!app) return false;
  const { list } = appAllowlist(app);
  return appInstallations().some((i) => !i.suspended && accountAllowed(list, i.accountLogin));
}

export function publicApp(): PublicGithubApp | null {
  const app = storedApp();
  if (!app) return null;
  const { list, isDefault } = appAllowlist(app);
  const installations: PublicGithubInstallation[] = appInstallations().map((i) => ({
    id: i.id,
    account: i.accountLogin,
    accountType: i.accountType,
    repositorySelection: i.repositorySelection === "all" ? "all" : "selected",
    repos: i.repos,
    suspended: i.suspended,
    allowed: accountAllowed(list, i.accountLogin),
    updatedAt: i.updatedAt,
  }));
  return {
    appId: app.appId,
    slug: app.slug,
    name: app.name,
    owner: app.ownerLogin,
    ownerType: app.ownerType,
    htmlUrl: app.htmlUrl ?? `https://github.com/apps/${app.slug}`,
    installUrl: appInstallUrl(app.slug),
    webhookSecretSet: !!app.webhookSecretCipher,
    createdAt: app.createdAt,
    installations,
    allowlist: list,
    allowlistIsDefault: isDefault,
    lastRefresh: getSetting<{ at: string; ok: boolean; detail: string }>(REFRESH_KEY) ?? null,
  };
}

// --- manifest flow ---

/** Step 1 (admin): the manifest, a one-time state, and where the browser should POST them. */
export function startManifest(user: CurrentUser, req: NextRequest, body: z.infer<typeof githubAppManifestSchema>, correlationId: string) {
  if (storedApp()) throw new HttpError(409, "app_exists", "A GitHub App is already set up. Forget it first to create another.");
  const sessionKey = sessionKeyFor(req, user);
  const origin = requestOrigin(req);
  const state = randomToken(32);
  const now = Date.now();
  const db = getDb();
  db.delete(S)
    .where(lt(S.expiresAt, new Date(now).toISOString()))
    .run();
  db.insert(S)
    .values({ id: sha256(state), userId: user.id, sessionKey, expiresAt: new Date(now + STATE_TTL_MS).toISOString() })
    .run();
  const manifest = buildManifest(origin, body.name);
  audit({
    actor: user.id,
    action: "github.app_manifest",
    source: "github",
    result: "ok",
    correlationId,
    detail: { name: body.name, target: body.target, org: body.org ?? null, origin },
  });
  return { action: manifestAction(body.target, body.org, state), manifest: JSON.stringify(manifest) };
}

/** Use a state once: it's deleted whatever the outcome. */
export function consumeState(state: string, who: { userId: string; sessionKey: string }, now = Date.now()) {
  if (!state || state.length > 200) return "unknown";
  const id = sha256(state);
  const db = getDb();
  const row = db.select().from(S).where(eq(S.id, id)).get();
  if (row) db.delete(S).where(eq(S.id, id)).run();
  return stateProblem(row, who, now);
}

type Conversion = {
  id: number;
  slug: string;
  name: string;
  owner: { login: string; type: string };
  html_url: string | null;
  client_id: string;
  client_secret: string;
  pem: string;
  webhook_secret: string | null;
};

async function githubCall(method: "GET" | "POST", path: string, bearer: string | null): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${githubApiBase()}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "jarvis-work-hub",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new HttpError(504, "github_timeout", "GitHub did not respond in time");
    throw new HttpError(502, "github_unreachable", "Could not reach GitHub");
  }
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
}

function parseConversion(b: unknown): Conversion | null {
  const o = b as Partial<Conversion> | null;
  if (!o || typeof o !== "object") return null;
  if (!Number.isInteger(o.id) || typeof o.slug !== "string" || typeof o.client_id !== "string" || typeof o.client_secret !== "string") return null;
  if (typeof o.pem !== "string" || !o.pem.includes("PRIVATE KEY") || typeof o.owner?.login !== "string") return null;
  return {
    id: o.id!,
    slug: o.slug,
    name: typeof o.name === "string" ? o.name : o.slug,
    owner: { login: o.owner.login, type: typeof o.owner.type === "string" ? o.owner.type : "User" },
    html_url: typeof o.html_url === "string" ? o.html_url : null,
    client_id: o.client_id,
    client_secret: o.client_secret,
    pem: o.pem,
    webhook_secret: typeof o.webhook_secret === "string" && o.webhook_secret ? o.webhook_secret : null,
  };
}

/**
 * Step 2 (GitHub redirected back): check the state against this admin's
 * session, exchange the code (POST /app-manifests/{code}/conversions) and
 * store the credentials encrypted. Returns an outcome code for the redirect;
 * never the credentials.
 */
export async function completeManifest(user: CurrentUser | null, req: NextRequest, code: string, state: string, correlationId: string): Promise<string> {
  if (!user || !user.capabilities.has("admin")) return "forbidden";
  let sessionKey: string;
  try {
    sessionKey = sessionKeyFor(req, user);
  } catch {
    return "forbidden";
  }
  const problem = consumeState(state, { userId: user.id, sessionKey });
  const fail = (outcome: string, detail: Record<string, unknown> = {}) => {
    audit({ actor: user.id, action: "github.app_create", source: "github", result: "error", correlationId, detail: { outcome, ...detail } });
    return outcome;
  };
  if (problem) return fail("state", { reason: problem });
  if (storedApp()) return fail("exists");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) return fail("missing_code");
  let res: { status: number; body: unknown };
  try {
    res = await githubCall("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, null);
  } catch {
    return fail("unreachable");
  }
  const c = res.status === 201 || res.status === 200 ? parseConversion(res.body) : null;
  if (!c) return fail("conversion", { status: res.status });
  const at = new Date().toISOString();
  getDb()
    .insert(A)
    .values({
      id: newId("gha"),
      appId: c.id,
      slug: c.slug,
      name: c.name,
      ownerLogin: c.owner.login,
      ownerType: c.owner.type,
      htmlUrl: c.html_url,
      clientId: c.client_id,
      clientSecretCipher: encrypt(c.client_secret),
      pemCipher: encrypt(c.pem),
      webhookSecretCipher: c.webhook_secret ? encrypt(c.webhook_secret) : null,
      createdBy: user.id,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  audit({
    actor: user.id,
    action: "github.app_create",
    source: "github",
    sourceRecord: String(c.id),
    result: "ok",
    correlationId,
    detail: { appId: c.id, slug: c.slug, owner: c.owner.login, webhookSecret: !!c.webhook_secret },
  });
  return "created";
}

// --- JWT, installations, tokens ---

function credentials() {
  const app = storedApp();
  if (!app) throw new HttpError(409, "app_missing", "Create the GitHub App first");
  const pem = plain(app.pemCipher);
  if (!pem) throw new HttpError(500, "app_key_unreadable", "The App's private key can't be decrypted (was the secret key changed?)");
  return { app, pem };
}

type TokenCache = Map<number, { token: string; expiresAtMs: number }>;
const tokenCache = () => processSingleton<TokenCache>("work_github_app_tokens", () => new Map());

export function __resetAppTokenCache() {
  tokenCache().clear();
}
export function dropInstallationToken(id: number) {
  tokenCache().delete(id);
}

/** An installation access token (POST /app/installations/{id}/access_tokens), cached until 5 min before it expires. */
export async function installationToken(installationId: number, now = Date.now()): Promise<string> {
  const cached = tokenCache().get(installationId);
  if (tokenFresh(cached, now)) return cached!.token;
  const { app, pem } = credentials();
  const r = await githubCall("POST", `/app/installations/${installationId}/access_tokens`, appJwt(app.appId, pem, now));
  const b = r.body as { token?: unknown; expires_at?: unknown } | null;
  if (r.status === 404) throw new HttpError(404, "github_installation_gone", "That installation no longer exists on GitHub");
  if (r.status !== 201 && r.status !== 200) throw new HttpError(502, "github_app_token", `GitHub refused an installation token (${r.status})`);
  if (typeof b?.token !== "string") throw new HttpError(502, "github_shape", "Unexpected response from GitHub");
  const exp = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
  const entry = { token: b.token, expiresAtMs: Number.isFinite(exp) ? exp : now + 60 * 60_000 };
  tokenCache().set(installationId, entry);
  return entry.token;
}

/** Token for `owner/repo` from an allowlisted installation covering it, or null (then: token connection, then env). */
export async function resolveAppToken(owner: string, repo?: string | null): Promise<ResolvedToken | null> {
  const app = storedApp();
  if (!app) return null;
  const inst = pickInstallation(appInstallations(), appAllowlist(app).list, owner, repo);
  if (!inst) return null;
  try {
    const token = await installationToken(inst.id);
    return { token, source: "app", connectionId: null, installationId: inst.id, backoffKey: `app:${inst.id}` };
  } catch (e) {
    console.error("[jarvis] GitHub App installation token failed; falling back", (e as Error).message);
    return null;
  }
}

function upsertInstallation(
  appRowId: string,
  v: { id: number; account: string; accountType: string; repositorySelection: string; repos?: string[] | null; suspended: boolean },
) {
  const at = new Date().toISOString();
  const values = {
    appRowId,
    accountLogin: v.account,
    accountKey: v.account.toLowerCase(),
    accountType: v.accountType,
    repositorySelection: v.repositorySelection === "all" ? "all" : "selected",
    suspended: v.suspended,
    updatedAt: at,
    ...(v.repos !== undefined ? { repos: v.repos === null ? null : JSON.stringify(v.repos) } : {}),
  };
  getDb()
    .insert(I)
    .values({ id: v.id, ...values })
    .onConflictDoUpdate({ target: I.id, set: values })
    .run();
}

/**
 * "Refresh" (admin) and after installing: GET /app/installations with the App
 * JWT, then GET /installation/repositories for each allowlisted, active
 * installation. Installations outside the allowlist are recorded (flagged)
 * but never get a token. Removed installations are forgotten.
 */
/** Every repository an installation covers (all pages). Null when any page can't be read, so coverage is never cached partially. */
export async function listInstallationRepos(token: string, maxPages = 50): Promise<string[] | null> {
  const names: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rr = await githubCall("GET", `/installation/repositories?per_page=100&page=${page}`, token);
    const b = rr.body as { repositories?: { name?: unknown }[]; total_count?: unknown } | null;
    if (rr.status !== 200 || !Array.isArray(b?.repositories)) return null;
    for (const x of b.repositories) if (typeof x.name === "string") names.push(x.name);
    const total = typeof b.total_count === "number" ? b.total_count : null;
    if (b.repositories.length < 100 || (total !== null && names.length >= total)) return names;
  }
  return null;
}

export async function refreshInstallations(actor: string, correlationId: string) {
  const { app, pem } = credentials();
  const at = new Date().toISOString();
  try {
    const r = await githubCall("GET", "/app/installations?per_page=100", appJwt(app.appId, pem));
    if (r.status !== 200 || !Array.isArray(r.body))
      throw new HttpError(502, "github_app_installations", `GitHub answered ${r.status} for the App's installations`);
    const { list } = appAllowlist(app);
    const seen = new Set<number>();
    let flagged = 0;
    for (const raw of r.body as Record<string, unknown>[]) {
      const id = Number(raw.id);
      const account = raw.account as { login?: unknown; type?: unknown } | null;
      if (!Number.isInteger(id) || typeof account?.login !== "string") continue;
      seen.add(id);
      const allowed = accountAllowed(list, account.login);
      const suspended = !!raw.suspended_at;
      let repos: string[] | null | undefined = undefined;
      if (allowed && !suspended) {
        dropInstallationToken(id);
        const token = await installationToken(id);
        repos = await listInstallationRepos(token);
      } else {
        dropInstallationToken(id);
        if (!allowed) flagged++;
      }
      upsertInstallation(app.id, {
        id,
        account: account.login,
        accountType: typeof account.type === "string" ? account.type : "User",
        repositorySelection: raw.repository_selection === "all" ? "all" : "selected",
        repos,
        suspended,
      });
    }
    for (const old of appInstallations()) {
      if (!seen.has(old.id)) {
        getDb().delete(I).where(eq(I.id, old.id)).run();
        dropInstallationToken(old.id);
      }
    }
    const detail = `${seen.size} installation${seen.size === 1 ? "" : "s"}${flagged ? `, ${flagged} ignored (not in the allowlist)` : ""}`;
    setSetting(REFRESH_KEY, { at, ok: true, detail });
    audit({ actor, action: "github.app_refresh", source: "github", result: "ok", correlationId, detail: { installations: seen.size, flagged } });
    return publicApp();
  } catch (e) {
    const detail = (e as Error).message.slice(0, 200);
    setSetting(REFRESH_KEY, { at, ok: false, detail });
    audit({ actor, action: "github.app_refresh", source: "github", result: "error", correlationId, detail: { error: detail } });
    throw e;
  }
}

/** installation / installation_repositories webhooks keep the installation list current without extra reads. */
export function applyInstallationEvent(ev: InstallationEvent) {
  const app = storedApp();
  if (!app) return { applied: false, allowed: false };
  const allowed = accountAllowed(appAllowlist(app).list, ev.account);
  dropInstallationToken(ev.id);
  if (ev.action === "deleted") {
    getDb().delete(I).where(eq(I.id, ev.id)).run();
    return { applied: true, allowed };
  }
  const current = appInstallations().find((i) => i.id === ev.id);
  // A full list (installation.created) replaces; added/removed (installation_repositories) adjust; otherwise keep.
  let repos: string[] | undefined = ev.repos ?? undefined;
  if (!repos && (ev.added.length || ev.removed.length)) {
    const removed = new Set(ev.removed.map((r) => r.toLowerCase()));
    repos = [...new Set([...(current?.repos ?? []).filter((r) => !removed.has(r.toLowerCase())), ...ev.added])];
  }
  upsertInstallation(app.id, {
    id: ev.id,
    account: ev.account,
    accountType: ev.accountType,
    repositorySelection: ev.repositorySelection,
    repos,
    suspended: ev.suspended,
  });
  return { applied: true, allowed };
}

/**
 * "Connect existing GitHub App" (admin): App id + private key (+ webhook
 * secret), write-only. Verified with the App JWT (GET /app must answer for
 * that id) before anything is stored; then the installations are read.
 */
export async function connectExistingApp(user: CurrentUser, body: z.infer<typeof githubAppConnectSchema>, correlationId: string) {
  if (storedApp()) throw new HttpError(409, "app_exists", "A GitHub App is already set up. Forget it first to connect another.");
  let jwt: string;
  try {
    jwt = appJwt(body.appId, body.pem);
  } catch {
    throw new HttpError(400, "app_key_invalid", "That private key can't sign (paste the whole .pem file)");
  }
  const r = await githubCall("GET", "/app", jwt);
  const b = r.body as {
    id?: unknown;
    slug?: unknown;
    name?: unknown;
    owner?: { login?: unknown; type?: unknown };
    client_id?: unknown;
    html_url?: unknown;
  } | null;
  if (r.status === 401 || r.status === 403) throw new HttpError(400, "app_auth", "GitHub refused that App ID and private key");
  if (r.status !== 200 || Number(b?.id) !== body.appId || typeof b?.slug !== "string" || typeof b.owner?.login !== "string")
    throw new HttpError(502, "app_lookup", `GitHub didn't confirm that App (${r.status})`);
  const at = new Date().toISOString();
  getDb()
    .insert(A)
    .values({
      id: newId("gha"),
      appId: body.appId,
      slug: b.slug,
      name: typeof b.name === "string" ? b.name : b.slug,
      ownerLogin: b.owner.login,
      ownerType: typeof b.owner.type === "string" ? b.owner.type : "User",
      htmlUrl: typeof b.html_url === "string" ? b.html_url : null,
      clientId: typeof b.client_id === "string" ? b.client_id : "",
      clientSecretCipher: null,
      pemCipher: encrypt(body.pem),
      webhookSecretCipher: body.webhookSecret ? encrypt(body.webhookSecret) : null,
      createdBy: user.id,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  audit({
    actor: user.id,
    action: "github.app_connect",
    source: "github",
    sourceRecord: String(body.appId),
    result: "ok",
    correlationId,
    detail: { appId: body.appId, slug: b.slug, owner: b.owner.login, webhookSecret: !!body.webhookSecret },
  });
  try {
    return await refreshInstallations(user.id, correlationId);
  } catch {
    return publicApp(); // stored; the refresh error is shown on the App card
  }
}

/** Replace the App's webhook secret (write-only). */
export function setAppWebhookSecret(user: CurrentUser, secret: string, correlationId: string) {
  const app = storedApp();
  if (!app) throw new HttpError(409, "app_missing", "Create the GitHub App first");
  getDb()
    .update(A)
    .set({ webhookSecretCipher: encrypt(secret), updatedAt: new Date().toISOString() })
    .where(eq(A.id, app.id))
    .run();
  audit({
    actor: user.id,
    action: "github.app_webhook_secret",
    source: "github",
    result: "ok",
    correlationId,
    detail: { replaced: !!app.webhookSecretCipher },
  });
  return publicApp();
}

export function setAppAllowlist(user: CurrentUser, list: string[] | null, correlationId: string) {
  if (!storedApp()) throw new HttpError(409, "app_missing", "Create the GitHub App first");
  setSetting(ALLOWLIST_KEY, list === null ? null : [...new Set(list.map((s) => s.toLowerCase()))]);
  __resetAppTokenCache();
  audit({ actor: user.id, action: "github.app_allowlist", source: "github", result: "ok", correlationId, detail: { allowlist: list } });
  return publicApp();
}

/** Forget the App locally (credentials, installations, allowlist). Deleting it on GitHub is the owner's step. */
export function forgetApp(user: CurrentUser, correlationId: string) {
  const app = storedApp();
  if (!app) throw new HttpError(404, "not_found", "No GitHub App is set up");
  getDb().delete(A).where(eq(A.id, app.id)).run();
  setSetting(ALLOWLIST_KEY, null);
  setSetting(REFRESH_KEY, null);
  __resetAppTokenCache();
  audit({
    actor: user.id,
    action: "github.app_forget",
    source: "github",
    sourceRecord: String(app.appId),
    result: "ok",
    correlationId,
    detail: { slug: app.slug },
  });
  return { ok: true };
}
