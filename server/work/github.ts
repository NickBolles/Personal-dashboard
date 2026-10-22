import "server-only";
import { config } from "@/server/config";
import { HttpError } from "@/server/http/errors";
import type { ExternalState, PrRef } from "@/lib/work";

/**
 * Optional, read-only GitHub readback for linked pull requests and issues.
 * Only GETs; Jarvis never writes to GitHub. The token stays on the server.
 */
const TIMEOUT_MS = 6000;

function token() {
  return config.githubToken;
}

export function githubRefreshEnabled() {
  return !!token();
}

async function get(url: string, what: string): Promise<Record<string, unknown>> {
  const t = token();
  if (!t) throw new HttpError(409, "github_not_configured", "Set JARVIS_GITHUB_TOKEN to refresh from GitHub");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${t}`, "x-github-api-version": "2022-11-28", "user-agent": "jarvis-work-hub" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new HttpError(504, "github_timeout", "GitHub did not respond in time");
    throw new HttpError(502, "github_unreachable", "Could not reach GitHub");
  }
  if (res.status === 404) throw new HttpError(404, "github_not_found", `GitHub couldn't find that ${what} (or the token can't see it)`);
  if (res.status === 401 || res.status === 403) throw new HttpError(502, "github_unauthorized", "GitHub refused the token");
  if (!res.ok) throw new HttpError(502, "github_error", `GitHub answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (body.state !== "open" && body.state !== "closed")) throw new HttpError(502, "github_shape", "Unexpected response from GitHub");
  return body;
}

const titleOf = (b: Record<string, unknown>) => (typeof b.title === "string" ? b.title.slice(0, 200) : null);
const repoPath = (ref: PrRef) => `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;

export async function fetchPullState(ref: PrRef): Promise<{ state: ExternalState; title: string | null }> {
  const body = await get(`${repoPath(ref)}/pulls/${ref.number}`, "pull request");
  const merged = body.merged === true || (typeof body.merged_at === "string" && !!body.merged_at);
  return { state: merged ? "merged" : body.state === "closed" ? "closed" : "open", title: titleOf(body) };
}

/** Issues are only open or closed. */
export async function fetchIssueState(ref: PrRef): Promise<{ state: ExternalState; title: string | null }> {
  const body = await get(`${repoPath(ref)}/issues/${ref.number}`, "issue");
  return { state: body.state === "closed" ? "closed" : "open", title: titleOf(body) };
}
