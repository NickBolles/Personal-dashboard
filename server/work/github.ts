import "server-only";
import { asc } from "drizzle-orm";
import { config } from "@/server/config";
import { getDb, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { processSingleton } from "@/server/singleton";
import type { ChecksState, ExternalState, PrRef } from "@/lib/work";
import { parseAssignedIssues, pickConnection, rateLimitBackoff, type AssignedIssue } from "./github-rules";
import { combineChecks } from "./github-app-rules";
import { appReadEnabled, resolveAppToken } from "./github-app";

/**
 * Read-only GitHub access for the Work hub. Only GETs; Jarvis never writes to
 * GitHub. Tokens stay on the server, in this order: the GitHub App's
 * installation covering the repo owner (server/work/github-app.ts), the
 * per-owner token connection (Settings → Connections → GitHub, encrypted),
 * then JARVIS_GITHUB_TOKEN.
 * The API base is JARVIS_GITHUB_API_URL (default https://api.github.com) so
 * tests never reach the real API.
 */
const TIMEOUT_MS = 6000;

export function githubApiBase() {
  return (process.env.JARVIS_GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

export type StoredConnection = {
  id: string;
  label: string;
  owner: string;
  ownerKey: string;
  repos: string[];
  createdBy: string;
  login: string | null;
};
export type ResolvedToken = {
  token: string;
  source: "app" | "connection" | "env";
  connectionId: string | null;
  installationId?: number | null;
  backoffKey: string;
};

function parseRepos(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function storedConnections(): (StoredConnection & { tokenCipher: string })[] {
  return getDb()
    .select()
    .from(schema.githubConnections)
    .orderBy(asc(schema.githubConnections.createdAt))
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      owner: r.owner,
      ownerKey: r.ownerKey,
      repos: parseRepos(r.repos),
      createdBy: r.createdBy,
      login: r.login,
      tokenCipher: r.tokenCipher,
    }));
}

export function decryptToken(cipher: string): string | null {
  try {
    return decrypt(cipher);
  } catch (err) {
    // Never log the value; only that it couldn't be read.
    console.error("[jarvis] could not decrypt a GitHub token (was the secret key changed?)", (err as Error).message);
    return null;
  }
}

/** Any way to read GitHub: an allowlisted App installation, a saved connection or JARVIS_GITHUB_TOKEN. */
export function githubRefreshEnabled() {
  return (
    !!config.githubToken || getDb().select({ id: schema.githubConnections.id }).from(schema.githubConnections).limit(1).all().length > 0 || appReadEnabled()
  );
}

/**
 * The token for `owner/repo`: an allowlisted GitHub App installation covering
 * it, else the connection for that owner (respecting its repo allowlist),
 * else JARVIS_GITHUB_TOKEN (backward compatible), else null.
 */
export async function resolveGithubToken(owner: string, repo?: string | null): Promise<ResolvedToken | null> {
  const app = await resolveAppToken(owner, repo);
  if (app) return app;
  const c = pickConnection(storedConnections(), owner, repo);
  if (c) {
    const token = decryptToken(c.tokenCipher);
    if (token) return { token, source: "connection", connectionId: c.id, backoffKey: `conn:${c.id}` };
  }
  return config.githubToken ? { token: config.githubToken, source: "env", connectionId: null, backoffKey: "env" } : null;
}

// --- rate-limit backoff (process-wide: route handlers and the poller share it) ---

type BackoffState = Map<string, { untilMs: number; failures: number }>;
const backoff = () => processSingleton<BackoffState>("work_github_backoff", () => new Map());

export function backoffUntil(key: string, now = Date.now()) {
  const b = backoff().get(key);
  return b && b.untilMs > now ? b.untilMs : null;
}
export function __resetGithubBackoff() {
  backoff().clear();
}

export type GithubResponse = { status: number; headers: Headers; body: unknown };

/** One read-only GET. Honours (and records) rate-limit backoff per token. */
export async function githubGet(path: string, auth: Pick<ResolvedToken, "token" | "backoffKey">, now = Date.now()): Promise<GithubResponse> {
  const waitUntil = backoffUntil(auth.backoffKey, now);
  if (waitUntil) throw new HttpError(503, "github_backoff", `GitHub rate limit: waiting until ${new Date(waitUntil).toISOString().slice(11, 16)} UTC`);
  let res: Response;
  try {
    res = await fetch(`${githubApiBase()}${path}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "jarvis-work-hub",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new HttpError(504, "github_timeout", "GitHub did not respond in time");
    throw new HttpError(502, "github_unreachable", "Could not reach GitHub");
  }
  const map = backoff();
  const limited = rateLimitBackoff(res, now, map.get(auth.backoffKey)?.failures ?? 0);
  if (limited) {
    map.set(auth.backoffKey, limited);
    throw new HttpError(503, "github_rate_limited", "GitHub rate limit reached; Jarvis will wait before reading again");
  }
  if (res.ok) map.delete(auth.backoffKey);
  const body = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, headers: res.headers, body };
}

export function checkStatus(r: GithubResponse, what: string) {
  if (r.status === 404) throw new HttpError(404, "github_not_found", `GitHub couldn't find that ${what} (or the token can't see it)`);
  if (r.status === 401 || r.status === 403) throw new HttpError(502, "github_unauthorized", "GitHub refused the token");
  if (r.status < 200 || r.status >= 300) throw new HttpError(502, "github_error", `GitHub answered ${r.status}`);
}

async function getState(
  ref: Pick<PrRef, "owner" | "repo" | "number">,
  what: "pull request" | "issue",
): Promise<{ body: Record<string, unknown>; auth: ResolvedToken }> {
  const auth = await resolveGithubToken(ref.owner, ref.repo);
  if (!auth) throw new HttpError(409, "github_not_configured", "Add a GitHub connection (Settings → Connections) to refresh from GitHub");
  const r = await githubGet(
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${what === "issue" ? "issues" : "pulls"}/${ref.number}`,
    auth,
  );
  checkStatus(r, what);
  const body = r.body as Record<string, unknown> | null;
  if (!body || (body.state !== "open" && body.state !== "closed")) throw new HttpError(502, "github_shape", "Unexpected response from GitHub");
  return { body, auth };
}

const titleOf = (b: Record<string, unknown>) => (typeof b.title === "string" ? b.title.slice(0, 200) : null);

/**
 * Combined CI state of a commit (read-only GETs: check suites + commit
 * statuses). Null when it can't be read (e.g. a token without checks/statuses
 * read access) — never fails the caller.
 */
export async function fetchChecksState(ref: Pick<PrRef, "owner" | "repo">, sha: string, auth?: ResolvedToken | null): Promise<ChecksState | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  const a = auth ?? (await resolveGithubToken(ref.owner, ref.repo));
  if (!a) return null;
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${sha}`;
  try {
    const [suites, status] = await Promise.all([githubGet(`${base}/check-suites?per_page=100`, a), githubGet(`${base}/status`, a)]);
    const list = suites.status === 200 ? ((suites.body as { check_suites?: unknown[] } | null)?.check_suites ?? []) : [];
    const combined = status.status === 200 ? (status.body as { state?: unknown; total_count?: unknown } | null) : null;
    if (suites.status !== 200 && status.status !== 200) return null;
    return combineChecks(list as Record<string, unknown>[], combined);
  } catch {
    return null;
  }
}

export async function fetchPullState(ref: PrRef): Promise<{ state: ExternalState; title: string | null; checks: ChecksState | null }> {
  const { body, auth } = await getState(ref, "pull request");
  const merged = body.merged === true || (typeof body.merged_at === "string" && !!body.merged_at);
  const sha = (body.head as { sha?: unknown } | null)?.sha;
  const checks = typeof sha === "string" ? await fetchChecksState(ref, sha, auth) : null;
  return { state: merged ? "merged" : body.state === "closed" ? "closed" : "open", title: titleOf(body), checks };
}

/** The PR's current head commit (read-only GET); null when it can't be read. */
export async function fetchPullHead(ref: Pick<PrRef, "owner" | "repo" | "number">): Promise<string | null> {
  try {
    const { body } = await getState(ref, "pull request");
    const sha = (body.head as { sha?: unknown } | null)?.sha;
    return typeof sha === "string" ? sha : null;
  } catch {
    return null;
  }
}

/** Issues are only open or closed. */
export async function fetchIssueState(ref: PrRef): Promise<{ state: ExternalState; title: string | null }> {
  const { body } = await getState(ref, "issue");
  return { state: body.state === "closed" ? "closed" : "open", title: titleOf(body) };
}

/** Open issues assigned to the token's user, limited to the connection's owner/allowlist. */
export async function fetchAssignedIssues(conn: StoredConnection & { tokenCipher: string }): Promise<AssignedIssue[]> {
  const token = decryptToken(conn.tokenCipher);
  if (!token) throw new HttpError(500, "github_token_unreadable", "The stored token can't be decrypted");
  const r = await githubGet("/issues?filter=assigned&state=open&per_page=100", { token, backoffKey: `conn:${conn.id}` });
  checkStatus(r, "issue list");
  return parseAssignedIssues(r.body, conn);
}
