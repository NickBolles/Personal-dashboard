/**
 * Pure GitHub rules for the Work hub (docs/work.md "GitHub"): token choice,
 * token warnings, rate-limit backoff, webhook signatures and payload mapping,
 * poller bounds. No I/O here: server/work/github*.ts do the reading/writing.
 */
import crypto from "node:crypto";
import type { ExternalState } from "@/lib/work";

// --- token resolution ---

export type ConnectionLike = { id: string; ownerKey: string; repos: string[] };

/**
 * The connection to read `owner/repo` with: the one whose owner matches the
 * repo owner (case-insensitive) and whose allowlist (if any) includes the
 * repo. Null means "fall back to JARVIS_GITHUB_TOKEN, if set".
 */
export function pickConnection<C extends ConnectionLike>(connections: C[], owner: string, repo?: string | null): C | null {
  const key = owner.toLowerCase();
  const c = connections.find((x) => x.ownerKey === key);
  if (!c) return null;
  if (repo && c.repos.length && !c.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return null;
  return c;
}

// --- token warnings ---

const WRITE_SCOPES = new Set([
  "repo",
  "public_repo",
  "workflow",
  "write:packages",
  "delete_repo",
  "admin:org",
  "write:org",
  "admin:repo_hook",
  "write:discussion",
]);
export const WRITE_WARNING = "This token can write — Jarvis only needs read. Prefer a fine-grained read-only token.";

export function tokenType(token: string): "classic" | "fine_grained" | "other" {
  if (token.startsWith("github_pat_")) return "fine_grained";
  if (token.startsWith("ghp_")) return "classic";
  return "other";
}

/** Parse x-oauth-scopes ("repo, read:org") — null when GitHub didn't send it (fine-grained tokens). */
export function parseScopes(header: string | null | undefined): string[] | null {
  if (header === null || header === undefined) return null;
  return header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Loud warnings for a token: classic tokens are all-or-nothing per scope (and
 * `repo` grants write), so any classic token, or any write/admin scope, warns.
 */
export function tokenWarnings(input: { type: "classic" | "fine_grained" | "other"; scopes: string[] | null }): string[] {
  const writes = (input.scopes ?? []).filter((s) => WRITE_SCOPES.has(s) || s.startsWith("admin:") || s.startsWith("write:"));
  const out: string[] = [];
  if (writes.length || input.type === "classic") out.push(WRITE_WARNING);
  if (writes.length) out.push(`Write scopes on this token: ${writes.join(", ")}.`);
  else if (input.type === "classic") out.push("Classic tokens can't be limited to read-only.");
  return out;
}

// --- rate limits ---

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/**
 * When a 403/429 is a rate limit, how long to wait before the next request
 * with that token. Uses `retry-after` (seconds) or `x-ratelimit-reset` (epoch
 * seconds) when present, otherwise exponential from 1 minute (capped at 1 h).
 * Returns null for responses that aren't rate limits (e.g. 403 forbidden).
 */
export function rateLimitBackoff(
  res: { status: number; headers: { get(name: string): string | null } },
  now: number,
  failures: number,
): { untilMs: number; failures: number } | null {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");
  const limited = res.status === 429 || (res.status === 403 && (remaining === "0" || retryAfter !== null));
  if (!limited) return null;
  const n = failures + 1;
  let until = now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) until = now + Math.max(1, Number(retryAfter)) * 1000;
  else if (remaining === "0" && reset !== null && Number.isFinite(Number(reset))) until = Math.max(now + 1000, Number(reset) * 1000 + 1000);
  return { untilMs: Math.min(until, now + BACKOFF_MAX_MS), failures: n };
}

// --- webhooks ---

/** Upper bound for a webhook payload Jarvis reads (GitHub caps at 25 MB; PR/issue events are far smaller). */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;

export function signBody(secret: string, body: string | Buffer) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time check of X-Hub-Signature-256 against the raw body. */
export function verifySignature(secret: string, body: string | Buffer, header: string | null | undefined) {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(signBody(secret, body));
  const actual = Buffer.from(header);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export type WebhookRef = { owner: string; repo: string; number: number };
export type PullEvent = WebhookRef & { kind: "pull"; state: ExternalState; title: string | null };
export type IssueEvent = WebhookRef & {
  kind: "issue";
  action: string;
  state: "open" | "closed";
  nodeId: string | null;
  title: string;
  url: string | null;
  assignees: string[];
};

function repoOf(payload: Obj): { owner: string; repo: string } | null {
  const r = obj(payload.repository);
  const full = str(r?.full_name);
  const m = full?.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** pull_request / issues payloads → what Jarvis needs (null for anything else or malformed). */
export function parseWebhookEvent(event: string, payload: unknown): PullEvent | IssueEvent | null {
  const p = obj(payload);
  if (!p) return null;
  const repo = repoOf(p);
  if (!repo) return null;
  if (event === "pull_request") {
    const pr = obj(p.pull_request);
    const number = Number(pr?.number ?? p.number);
    if (!pr || !Number.isInteger(number) || number <= 0) return null;
    const merged = pr.merged === true || !!str(pr.merged_at);
    const state: ExternalState = merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    return { kind: "pull", ...repo, number, state, title: str(pr.title)?.slice(0, 200) ?? null };
  }
  if (event === "issues") {
    const is = obj(p.issue);
    const number = Number(is?.number);
    if (!is || !Number.isInteger(number) || number <= 0 || is.pull_request) return null;
    const assignees = (Array.isArray(is.assignees) ? is.assignees : [])
      .map((a) => str(obj(a)?.login))
      .filter((x): x is string => !!x)
      .map((x) => x.toLowerCase());
    return {
      kind: "issue",
      ...repo,
      number,
      action: str(p.action) ?? "",
      state: is.state === "closed" ? "closed" : "open",
      nodeId: str(is.node_id),
      title: str(is.title)?.slice(0, 300) ?? `${repo.owner}/${repo.repo}#${number}`,
      url: str(is.html_url),
      assignees,
    };
  }
  return null;
}

/** The link target id Work stores for a PR/issue ("owner/repo#n"), lowercased for matching. */
export const linkKey = (r: WebhookRef) => `${r.owner}/${r.repo}#${r.number}`.toLowerCase();

// --- assigned issues ---

export type AssignedIssue = { nodeId: string; title: string; url: string; repo: string; owner: string; number: number };

/**
 * GET /issues?filter=assigned → open issues (not PRs) in repos of the
 * connection's owner (and its allowlist, if any), capped.
 */
export function parseAssignedIssues(body: unknown, conn: { ownerKey: string; repos: string[] }, max = 100): AssignedIssue[] {
  if (!Array.isArray(body)) return [];
  const out: AssignedIssue[] = [];
  for (const raw of body) {
    const is = obj(raw);
    if (!is || is.pull_request || is.state === "closed") continue;
    const nodeId = str(is.node_id);
    const url = str(is.html_url);
    const number = Number(is.number);
    const repo = obj(is.repository);
    const full = str(repo?.full_name) ?? url?.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ?? null;
    if (!nodeId || !url || !full || !Number.isInteger(number)) continue;
    const [owner, name] = full.split("/") as [string, string];
    if (owner.toLowerCase() !== conn.ownerKey) continue;
    if (conn.repos.length && !conn.repos.some((r) => r.toLowerCase() === name.toLowerCase())) continue;
    out.push({ nodeId, title: str(is.title)?.slice(0, 300) ?? `${full}#${number}`, url, repo: full, owner, number });
    if (out.length >= max) break;
  }
  return out;
}

// --- poller ---

/** Links read per poller tick, GitHub requests in flight, and the per-link minimum interval. */
export const POLL_MAX_LINKS = 50;
export const POLL_PARALLELISM = 4;
export const POLL_LINK_MIN_INTERVAL_MS = 5 * 60_000;
/** How often the scheduler wakes to see whether a tick is due. */
export const POLL_WAKE_MS = 60_000;

/** Is a poller tick due? `pollMinutes` 0 is off. */
export function pollDue(lastTickAt: number | null, now: number, pollMinutes: number) {
  if (!(pollMinutes > 0)) return false;
  return lastTickAt === null || now - lastTickAt >= pollMinutes * 60_000;
}
