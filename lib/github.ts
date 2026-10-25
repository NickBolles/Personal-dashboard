/**
 * GitHub connections for the Work hub: client-safe types and request schemas
 * (Settings → Connections → GitHub). Tokens are write-only: nothing here ever
 * carries one back to a browser. Rules: docs/work.md "GitHub".
 */
import { z } from "zod";

export type GithubTestCheck = { name: string; ok: boolean; detail?: string };
export type GithubRepoPermission = { repo: string; admin: boolean; push: boolean; pull: boolean };
export type GithubTestResult = {
  ok: boolean;
  checkedAt: string;
  summary: string;
  checks: GithubTestCheck[];
  /** GitHub login the token belongs to */
  login: string | null;
  /** classic (ghp_), fine_grained (github_pat_) or other */
  tokenType: "classic" | "fine_grained" | "other";
  /** x-oauth-scopes (classic tokens only) */
  scopes: string[] | null;
  /** the account's role on each allowlisted repo, when GitHub reports it */
  permissions: GithubRepoPermission[];
  /** loud warnings, e.g. "This token can write" */
  warnings: string[];
};

/** What the browser sees of a connection: never the token, only its last four characters. */
export type PublicGithubConnection = {
  id: string;
  label: string;
  owner: string;
  tokenHint: string;
  repos: string[];
  login: string | null;
  lastTest: GithubTestResult | null;
  createdAt: string;
  updatedAt: string;
};

export type GithubSettingsResponse = {
  connections: PublicGithubConnection[];
  /** JARVIS_GITHUB_TOKEN is set on the server (fallback for owners without a connection) */
  envToken: boolean;
  webhook: { path: string; secretSet: boolean; secretCreatedAt: string | null };
  pollMinutes: number;
  poller: { running: boolean; lastTickAt: string | null; lastResult: string | null };
  /** the read-only GitHub App (manifest flow), if one was created */
  app: PublicGithubApp | null;
  /** what "Create GitHub App" would send (no secrets) */
  appSetup: GithubAppSetup;
};

export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

const owner = z.string().trim().regex(GITHUB_OWNER_RE, "A GitHub user or organization name");
const repos = z
  .array(z.string().trim().regex(GITHUB_REPO_RE, "Repository names only (no owner/)"))
  .max(50, "Up to 50 repositories")
  .transform((list) => [...new Set(list.filter(Boolean))]);
const token = z
  .string()
  .trim()
  .min(20, "That doesn't look like a GitHub token")
  .max(255)
  .regex(/^[A-Za-z0-9_]+$/, "That doesn't look like a GitHub token");

export const githubConnectionCreateSchema = z
  .object({ label: z.string().trim().min(1, "Label is required").max(80), owner, token, repos: repos.default([]) })
  .strict();
export const githubConnectionUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    owner: owner.optional(),
    /** a new token replaces the stored one; omit to keep it */
    token: token.optional(),
    repos: repos.optional(),
  })
  .strict();
export const githubSettingsSchema = z.object({ pollMinutes: z.number().int().min(0).max(1440) }).strict();

/** "a, b\nc" → ["a","b","c"] (the repo allowlist input) */
export function parseRepoList(text: string) {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^.*\//, ""))
    .filter(Boolean);
}

/** The prefilled fine-grained, read-only token form for an owner. */
export function fineGrainedTokenUrl(ownerName: string) {
  return `https://github.com/settings/personal-access-tokens/new?name=Jarvis%20read-only&target_name=${encodeURIComponent(ownerName || "<owner>")}&expires_in=365&pull_requests=read&issues=read`;
}

export const WEBHOOK_PATH = "/api/work/github/webhook";
export const DEFAULT_POLL_MINUTES = 10;

// --- GitHub App (manifest flow; docs/work.md "GitHub App") ---

export const GITHUB_WEB = "https://github.com";
export const APP_CALLBACK_PATH = "/api/github/app/callback";
/** GitHub limits App names to 34 characters and they must be unique on GitHub. */
export const APP_NAME_MAX = 34;

export type GithubAppSetup = {
  /** "Jarvis (<host>)", trimmed to 34 characters */
  defaultName: string;
  origin: string;
  callbackUrl: string;
  webhookUrl: string;
  /** GitHub can only deliver webhooks to a public https URL */
  https: boolean;
};

export type PublicGithubInstallation = {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repos: string[] | null;
  suspended: boolean;
  /** in the account allowlist; otherwise ignored (no tokens, webhooks dropped) and flagged */
  allowed: boolean;
  updatedAt: string;
};

/** What the browser sees of the App: never the client secret, private key or webhook secret. */
export type PublicGithubApp = {
  appId: number;
  slug: string;
  name: string;
  owner: string;
  ownerType: string;
  htmlUrl: string;
  installUrl: string;
  webhookSecretSet: boolean;
  createdAt: string;
  installations: PublicGithubInstallation[];
  allowlist: string[];
  allowlistIsDefault: boolean;
  lastRefresh: { at: string; ok: boolean; detail: string } | null;
};

export const githubAppManifestSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(APP_NAME_MAX, `GitHub allows up to ${APP_NAME_MAX} characters`),
    target: z.enum(["user", "org"]),
    org: z.string().trim().regex(GITHUB_OWNER_RE, "A GitHub organization name").optional(),
  })
  .strict()
  .refine((v) => v.target === "user" || !!v.org, { message: "Organization is required", path: ["org"] });

const webhookSecretField = z.string().trim().min(16, "Webhook secrets are at least 16 characters").max(255);

export const githubAppUpdateSchema = z
  .object({
    /** accounts whose installations Jarvis uses; null = default (token owners + the App owner) */
    allowlist: z.array(z.string().trim().regex(GITHUB_OWNER_RE, "GitHub user or organization names")).max(50).nullable().optional(),
    /** replace the App's webhook secret (write-only) */
    webhookSecret: webhookSecretField.optional(),
  })
  .strict();

/** "Connect existing GitHub App": App id + private key (+ webhook secret), all write-only; checked with GET /app. */
export const githubAppConnectSchema = z
  .object({
    appId: z.coerce.number().int().positive("The App ID is a number").max(1e12),
    pem: z
      .string()
      .trim()
      .max(10_000)
      .refine((v) => /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----/.test(v), "Paste the App's private key (.pem)"),
    webhookSecret: webhookSecretField.optional(),
  })
  .strict();

export function appInstallUrl(slug: string) {
  return `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** Callback outcomes shown on Settings → Connections (`?github_app=<code>`). */
export const APP_CALLBACK_MESSAGES: Record<string, string> = {
  created: "GitHub App created. Next: install it on your account and organization.",
  installed: "Installed on GitHub. Jarvis is reading the installations…",
  state: "That GitHub link expired or wasn't started from this session. Start again from “Create GitHub App”.",
  forbidden: "Only an admin signed in to Jarvis can finish creating the GitHub App.",
  exists: "A GitHub App is already set up. Forget it first to create another.",
  missing_code: "GitHub didn't send a code back. Start again.",
  conversion: "GitHub refused the code (it's single-use and expires after an hour). Start again.",
  unreachable: "Couldn't reach GitHub to finish. Start again.",
};
