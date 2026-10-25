/**
 * Pure rules for the read-only GitHub App (docs/work.md "GitHub App"): the
 * manifest, where it's posted, manifest-state checks, the App JWT (RS256 with
 * node:crypto), installation-token freshness, the account allowlist, which
 * installation covers a repo, combined CI state, and installation/check
 * webhook payloads. No I/O: server/work/github-app.ts does that.
 */
import crypto from "node:crypto";
import type { ChecksState } from "@/lib/work";
import { APP_CALLBACK_PATH, APP_NAME_MAX, GITHUB_WEB, WEBHOOK_PATH } from "@/lib/github";

// --- manifest ---

export const APP_PERMISSIONS = {
  metadata: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
} as const;
export const APP_EVENTS = ["pull_request", "pull_request_review", "issues", "check_suite", "workflow_run"] as const;
/** How long a manifest `state` stays valid (GitHub's code itself is valid for an hour). */
export const STATE_TTL_MS = 10 * 60_000;

/** "Jarvis (jarvis.example.com)", trimmed to GitHub's 34-character limit. */
export function defaultAppName(origin: string) {
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    /* keep as is */
  }
  const name = `Jarvis (${host})`;
  return name.length <= APP_NAME_MAX ? name : `${name.slice(0, APP_NAME_MAX - 2)}…)`;
}

export function buildManifest(origin: string, name: string) {
  return {
    name,
    url: origin,
    description: "Read-only access for the Jarvis Work hub: pull request, issue and CI state. Jarvis never writes to GitHub.",
    hook_attributes: { url: `${origin}${WEBHOOK_PATH}`, active: true },
    redirect_url: `${origin}${APP_CALLBACK_PATH}`,
    // After installing, GitHub sends the browser back to Settings, which refreshes the installations.
    setup_url: `${origin}/settings/connections?github_app=installed`,
    setup_on_update: true,
    public: true,
    request_oauth_on_install: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [...APP_EVENTS],
  };
}

/** Where the browser POSTs the manifest: the user's or an organization's "new App" page, with the state. */
export function manifestAction(target: "user" | "org", org: string | undefined, state: string) {
  const base = target === "org" && org ? `${GITHUB_WEB}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${GITHUB_WEB}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

export type StoredState = { userId: string; sessionKey: string; expiresAt: string };

/** Why a callback's state is refused, or null when it's good (same admin, same session, not expired). */
export function stateProblem(row: StoredState | null | undefined, who: { userId: string; sessionKey: string }, now = Date.now()): string | null {
  if (!row) return "unknown";
  if (Date.parse(row.expiresAt) <= now) return "expired";
  if (row.userId !== who.userId) return "other_user";
  if (row.sessionKey !== who.sessionKey) return "other_session";
  return null;
}

// --- App JWT (RS256) ---

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/**
 * The App's JSON Web Token: RS256 over {iat: now-60s (clock drift), exp: now+9min
 * (GitHub's limit is 10), iss: App id}, signed with the App's private key.
 */
export function appJwt(appId: number | string, pem: string, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pem);
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Verify an RS256 JWT with a public key (tests and the mock). Returns the payload or null. */
export function verifyJwt(token: string, publicKey: crypto.KeyLike): Record<string, unknown> | null {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
  if (!ok) return null;
  try {
    return JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- installation tokens ---

/** Installation tokens are reused until 5 minutes before they expire (GitHub issues them for an hour). */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export function tokenFresh(entry: { expiresAtMs: number } | null | undefined, now = Date.now()) {
  return !!entry && now < entry.expiresAtMs - TOKEN_REFRESH_MARGIN_MS;
}

// --- allowlist and coverage ---

/** Default allowlist: owners of the saved token connections plus the App's owner (lowercase, unique). */
export function defaultAllowlist(connectionOwners: string[], appOwner: string | null | undefined) {
  return [...new Set([...connectionOwners, ...(appOwner ? [appOwner] : [])].map((o) => o.trim().toLowerCase()).filter(Boolean))];
}

export function accountAllowed(allowlist: string[], login: string | null | undefined) {
  return !!login && allowlist.includes(login.toLowerCase());
}

export type InstallationLike = { id: number; accountKey: string; repositorySelection: string; repos: string[] | null; suspended: boolean };

/**
 * The installation to read `owner/repo` with: on that account, allowlisted,
 * not suspended, and covering the repo (all repositories, or the repo is in
 * its selection; an unread selection is trusted until GitHub says otherwise).
 */
export function pickInstallation<I extends InstallationLike>(installations: I[], allowlist: string[], owner: string, repo?: string | null): I | null {
  const key = owner.toLowerCase();
  for (const i of installations) {
    if (i.accountKey !== key || i.suspended || !allowlist.includes(key)) continue;
    if (i.repositorySelection === "all" || !repo || i.repos === null) return i;
    if (i.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return i;
  }
  return null;
}

// --- CI state ---

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/**
 * Combined CI state of a commit from GET …/commits/{sha}/check-suites and
 * GET …/commits/{sha}/status. Suites with no check runs (apps that never ran)
 * are ignored. Any failure → failure; anything still running → pending;
 * otherwise success; nothing reported → null.
 */
export function combineChecks(
  suites: { status?: unknown; conclusion?: unknown; latest_check_runs_count?: unknown }[],
  status: { state?: unknown; total_count?: unknown } | null,
): ChecksState | null {
  const real = suites.filter((s) => s.latest_check_runs_count === undefined || Number(s.latest_check_runs_count) > 0);
  const statusCount = Number(status?.total_count ?? 0);
  const statusState = statusCount > 0 ? String(status?.state ?? "") : "";
  if (real.some((s) => s.status === "completed" && FAILED.has(String(s.conclusion))) || statusState === "failure" || statusState === "error") return "failure";
  if (real.some((s) => s.status !== "completed") || statusState === "pending") return "pending";
  if (real.length || statusCount > 0) return "success";
  return null;
}

/** A single check suite / workflow run → its own state (used when the combined state can't be read). */
export function runState(status: unknown, conclusion: unknown): ChecksState {
  if (status !== "completed") return "pending";
  return FAILED.has(String(conclusion)) ? "failure" : "success";
}

// --- webhook payloads ---

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export type InstallationEvent = {
  kind: "installation";
  action: string;
  id: number;
  account: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  /** full repo list (installation.created) */
  repos: string[] | null;
  added: string[];
  removed: string[];
  suspended: boolean;
};

const repoNames = (v: unknown) =>
  (Array.isArray(v) ? v : []).map((r) => str(obj(r)?.name) ?? str(obj(r)?.full_name)?.split("/")[1] ?? null).filter((x): x is string => !!x);

/** installation / installation_repositories payloads → what Jarvis keeps (null if malformed). */
export function parseInstallationEvent(event: string, payload: unknown): InstallationEvent | null {
  const p = obj(payload);
  const inst = obj(p?.installation);
  const account = obj(inst?.account);
  const id = Number(inst?.id);
  const login = str(account?.login);
  if (!p || !inst || !Number.isInteger(id) || id <= 0 || !login) return null;
  if (event !== "installation" && event !== "installation_repositories") return null;
  const action = str(p.action) ?? "";
  return {
    kind: "installation",
    action,
    id,
    account: login,
    accountType: str(account?.type) ?? "User",
    repositorySelection: (str(p.repository_selection) ?? str(inst.repository_selection)) === "all" ? "all" : "selected",
    repos: event === "installation" && Array.isArray(p.repositories) ? repoNames(p.repositories) : null,
    added: repoNames(p.repositories_added),
    removed: repoNames(p.repositories_removed),
    suspended: action === "suspend" || (action !== "unsuspend" && !!inst.suspended_at),
  };
}

export type ChecksEvent = { kind: "checks"; owner: string; repo: string; sha: string | null; prNumbers: number[]; state: ChecksState };

/** check_suite / workflow_run payloads → the PRs they belong to and their own state. */
export function parseChecksEvent(event: string, payload: unknown): ChecksEvent | null {
  const p = obj(payload);
  if (!p) return null;
  const full = str(obj(p.repository)?.full_name);
  const m = full?.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const run = event === "check_suite" ? obj(p.check_suite) : event === "workflow_run" ? obj(p.workflow_run) : null;
  if (!run) return null;
  const prNumbers = (Array.isArray(run.pull_requests) ? run.pull_requests : []).map((x) => Number(obj(x)?.number)).filter((n) => Number.isInteger(n) && n > 0);
  return { kind: "checks", owner: m[1]!, repo: m[2]!, sha: str(run.head_sha), prNumbers: [...new Set(prNumbers)], state: runState(run.status, run.conclusion) };
}

/** The account an App delivery is about (repository owner, else the installation account); null for non-App deliveries. */
export function deliveryAccount(payload: unknown): { installationId: number; account: string | null } | null {
  const p = obj(payload);
  const inst = obj(p?.installation);
  const id = Number(inst?.id);
  if (!p || !inst || !Number.isInteger(id)) return null;
  const owner = str(obj(obj(p.repository)?.owner)?.login) ?? str(obj(p.repository)?.full_name)?.split("/")[0] ?? str(obj(inst.account)?.login);
  return { installationId: id, account: owner ?? null };
}
