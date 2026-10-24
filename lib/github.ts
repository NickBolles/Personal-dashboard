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
