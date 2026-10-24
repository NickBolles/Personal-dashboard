import "server-only";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { getDb, schema } from "@/server/db";
import { config } from "@/server/config";
import { decrypt, encrypt, newId, randomToken } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { getSetting, setSetting } from "@/server/settings";
import {
  DEFAULT_POLL_MINUTES,
  WEBHOOK_PATH,
  type githubConnectionCreateSchema,
  type githubConnectionUpdateSchema,
  type GithubSettingsResponse,
  type GithubTestCheck,
  type GithubTestResult,
  type PublicGithubConnection,
} from "@/lib/github";
import { checkStatus, decryptToken, githubGet, storedConnections } from "./github";
import { parseScopes, tokenType, tokenWarnings } from "./github-rules";

/**
 * Admin settings for GitHub (Settings → Connections → GitHub): one read-only
 * token per owner, the webhook secret and the poll interval. Tokens are
 * write-only: responses carry "•••• last4" and nothing else. Every save,
 * delete, test and secret change is audited without the secret.
 */

const C = schema.githubConnections;
const WEBHOOK_KEY = "work.github.webhook_secret";
export const POLL_MINUTES_KEY = "work.github.poll_minutes";

function toPublic(r: typeof C.$inferSelect): PublicGithubConnection {
  let repos: string[] = [];
  try {
    repos = JSON.parse(r.repos) as string[];
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    label: r.label,
    owner: r.owner,
    tokenHint: `•••• ${r.tokenLast4}`,
    repos,
    login: r.login,
    lastTest: r.lastTestResult ? (JSON.parse(r.lastTestResult) as GithubTestResult) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function row(id: string) {
  const r = getDb().select().from(C).where(eq(C.id, id)).get();
  if (!r) throw new HttpError(404, "not_found", "GitHub connection not found");
  return r;
}

export function listGithubConnections(): PublicGithubConnection[] {
  return getDb().select().from(C).orderBy(C.createdAt).all().map(toPublic);
}

function ownerTaken(ownerKey: string, exceptId?: string) {
  const r = getDb().select({ id: C.id }).from(C).where(eq(C.ownerKey, ownerKey)).get();
  return !!r && r.id !== exceptId;
}

export function createGithubConnection(user: CurrentUser, body: z.infer<typeof githubConnectionCreateSchema>, correlationId: string) {
  const ownerKey = body.owner.toLowerCase();
  if (ownerTaken(ownerKey)) throw new HttpError(409, "owner_exists", `There's already a connection for ${body.owner}`);
  const id = newId("ghc");
  const at = new Date().toISOString();
  getDb()
    .insert(C)
    .values({
      id,
      label: body.label,
      owner: body.owner,
      ownerKey,
      tokenCipher: encrypt(body.token),
      tokenLast4: body.token.slice(-4),
      repos: JSON.stringify(body.repos),
      createdBy: user.id,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  audit({
    actor: user.id,
    action: "github.connection_add",
    source: "github",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { owner: body.owner, repos: body.repos.length },
  });
  return toPublic(row(id));
}

export function updateGithubConnection(user: CurrentUser, id: string, body: z.infer<typeof githubConnectionUpdateSchema>, correlationId: string) {
  const r = row(id);
  const patch: Partial<typeof C.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (body.label !== undefined) patch.label = body.label;
  if (body.owner !== undefined) {
    if (ownerTaken(body.owner.toLowerCase(), id)) throw new HttpError(409, "owner_exists", `There's already a connection for ${body.owner}`);
    patch.owner = body.owner;
    patch.ownerKey = body.owner.toLowerCase();
  }
  if (body.repos !== undefined) patch.repos = JSON.stringify(body.repos);
  if (body.token !== undefined) {
    patch.tokenCipher = encrypt(body.token);
    patch.tokenLast4 = body.token.slice(-4);
    // A new token hasn't been tested yet.
    Object.assign(patch, { lastTestAt: null, lastTestOk: null, lastTestResult: null, login: null });
  }
  getDb().update(C).set(patch).where(eq(C.id, r.id)).run();
  audit({
    actor: user.id,
    action: "github.connection_update",
    source: "github",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { fields: Object.keys(body).filter((k) => k !== "token"), tokenReplaced: body.token !== undefined },
  });
  return toPublic(row(id));
}

export function deleteGithubConnection(user: CurrentUser, id: string, correlationId: string) {
  const r = row(id);
  getDb().delete(C).where(eq(C.id, id)).run();
  audit({ actor: user.id, action: "github.connection_remove", source: "github", sourceRecord: id, result: "ok", correlationId, detail: { owner: r.owner } });
  return { ok: true };
}

/**
 * Read-only checks with the stored token: GET /user (login + x-oauth-scopes),
 * then GET /repos/{owner}/{repo} for each allowlisted repo, or GET
 * /orgs/{owner} (falling back to /users/{owner}) and /rate_limit. Records the
 * result (never the token) and warns loudly when the token can write.
 */
export async function testGithubConnection(user: CurrentUser, id: string, correlationId: string): Promise<GithubTestResult> {
  const r = row(id);
  const conn = storedConnections().find((c) => c.id === id)!;
  const token = decryptToken(r.tokenCipher);
  const checks: GithubTestCheck[] = [];
  const auth = { token: token ?? "", backoffKey: `conn:${id}` };
  let login: string | null = null;
  let scopes: string[] | null = null;
  const permissions: GithubTestResult["permissions"] = [];
  const type = token ? tokenType(token) : "other";
  const step = async (name: string, fn: () => Promise<string | undefined>) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      checks.push({ name, ok: false, detail: (e as Error).message });
    }
  };
  if (!token) checks.push({ name: "Token", ok: false, detail: "The stored token can't be decrypted (was the secret key changed?)" });
  else {
    await step("GET /user", async () => {
      const res = await githubGet("/user", auth);
      checkStatus(res, "user");
      scopes = parseScopes(res.headers.get("x-oauth-scopes"));
      const b = res.body as { login?: unknown } | null;
      login = typeof b?.login === "string" ? b.login : null;
      return login ? `Signed in as ${login}` : "OK";
    });
    if (conn.repos.length) {
      for (const repo of conn.repos.slice(0, 10))
        await step(`GET /repos/${conn.owner}/${repo}`, async () => {
          const res = await githubGet(`/repos/${encodeURIComponent(conn.owner)}/${encodeURIComponent(repo)}`, auth);
          checkStatus(res, "repository");
          const p = (res.body as { permissions?: Record<string, unknown> } | null)?.permissions;
          if (p) permissions.push({ repo, admin: p.admin === true, push: p.push === true, pull: p.pull === true });
          return p ? `Readable${p.push === true ? " (your account can push here)" : ""}` : "Readable";
        });
    } else {
      await step(`GET /orgs/${conn.owner}`, async () => {
        const res = await githubGet(`/orgs/${encodeURIComponent(conn.owner)}`, auth);
        if (res.status === 404) {
          const u = await githubGet(`/users/${encodeURIComponent(conn.owner)}`, auth);
          checkStatus(u, "user or organization");
          return "A user account";
        }
        checkStatus(res, "organization");
        return "An organization";
      });
      await step("GET /rate_limit", async () => {
        const res = await githubGet("/rate_limit", auth);
        checkStatus(res, "rate limit");
        const core = (res.body as { resources?: { core?: { remaining?: number; limit?: number } } } | null)?.resources?.core;
        return core ? `${core.remaining}/${core.limit} requests left this hour` : "OK";
      });
    }
  }
  const warnings = token ? tokenWarnings({ type, scopes }) : [];
  const ok = checks.every((c) => c.ok);
  const result: GithubTestResult = {
    ok,
    checkedAt: new Date().toISOString(),
    summary: ok ? (warnings.length ? "Works, but this token can write" : "Read access works") : (checks.find((c) => !c.ok)?.detail ?? "Failed"),
    checks,
    login,
    tokenType: type,
    scopes,
    permissions,
    warnings,
  };
  getDb()
    .update(C)
    .set({ lastTestAt: result.checkedAt, lastTestOk: ok, lastTestResult: JSON.stringify(result), ...(login ? { login } : {}) })
    .where(eq(C.id, id))
    .run();
  audit({
    actor: user.id,
    action: "github.connection_test",
    source: "github",
    sourceRecord: id,
    result: ok ? "ok" : "error",
    correlationId,
    detail: { ok, tokenType: type, warnings: warnings.length },
  });
  return result;
}

// --- webhook secret (one, generated server-side; shown once) ---

type StoredSecret = { cipher: string; createdAt: string };

export function webhookSecret(): string | null {
  const s = getSetting<StoredSecret>(WEBHOOK_KEY);
  if (!s?.cipher) return null;
  try {
    return decrypt(s.cipher);
  } catch {
    return null;
  }
}

/** Generate (or replace) the webhook secret. The plaintext is returned only here, once. */
export function regenerateWebhookSecret(user: CurrentUser, correlationId: string) {
  const secret = randomToken(32);
  const createdAt = new Date().toISOString();
  const replaced = !!getSetting<StoredSecret>(WEBHOOK_KEY);
  setSetting(WEBHOOK_KEY, { cipher: encrypt(secret), createdAt });
  audit({ actor: user.id, action: "github.webhook_secret", source: "github", result: "ok", correlationId, detail: { replaced } });
  return { secret, createdAt };
}

export function pollMinutes(): number {
  const v = getSetting<number>(POLL_MINUTES_KEY);
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : DEFAULT_POLL_MINUTES;
}

export function setPollMinutes(user: CurrentUser, minutes: number, correlationId: string) {
  setSetting(POLL_MINUTES_KEY, minutes);
  audit({ actor: user.id, action: "github.poll_minutes", source: "github", result: "ok", correlationId, detail: { minutes } });
  return minutes;
}

export function githubSettings(poller: GithubSettingsResponse["poller"]): GithubSettingsResponse {
  const s = getSetting<StoredSecret>(WEBHOOK_KEY);
  return {
    connections: listGithubConnections(),
    envToken: !!config.githubToken,
    webhook: { path: WEBHOOK_PATH, secretSet: !!s?.cipher, secretCreatedAt: s?.createdAt ?? null },
    pollMinutes: pollMinutes(),
    poller,
  };
}
