import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can, type Capable } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { matchScore } from "@/lib/search";
import { checkStatus, githubGet, resolveGithubToken } from "./github";

/**
 * The composer's `#` picker (read-only): pull requests and issues in a repo
 * (the area's default repo, or one the person types), from GitHub's issue
 * search with the usual token resolution (App installation → connection →
 * JARVIS_GITHUB_TOKEN), plus PRs/issues already linked to their work (local,
 * works without any token). Only GETs.
 */

export type GithubRefItem = { repo: string; number: number; title: string; kind: "pull" | "issues"; state: string; linked: boolean };
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LIMIT = 10;

function linkedRefs(userId: string): GithubRefItem[] {
  const rows = getDb()
    .select({ kind: schema.workLinks.kind, targetId: schema.workLinks.targetId, title: schema.workLinks.title, state: schema.workLinks.externalState })
    .from(schema.workLinks)
    .innerJoin(schema.workItems, eq(schema.workItems.id, schema.workLinks.itemId))
    .where(and(eq(schema.workItems.userId, userId)))
    .all()
    .filter((r) => (r.kind === "github_pr" || r.kind === "github_issue") && r.targetId);
  const seen = new Set<string>();
  const out: GithubRefItem[] = [];
  for (const r of rows) {
    const m = r.targetId!.match(/^(.+\/.+)#(\d+)$/);
    if (!m || seen.has(r.targetId!)) continue;
    seen.add(r.targetId!);
    out.push({ repo: m[1]!, number: Number(m[2]), title: r.title, kind: r.kind === "github_pr" ? "pull" : "issues", state: r.state ?? "open", linked: true });
  }
  return out;
}

export async function searchGithubRefs(
  user: CurrentUser & Capable,
  repo: string | null,
  q: string,
): Promise<{ items: GithubRefItem[]; partial: string[]; searched: boolean }> {
  const query = q.trim().slice(0, 100);
  const partial: string[] = [];
  const local = can(user, "work.use")
    ? linkedRefs(user.id)
        .filter((i) => !repo || i.repo.toLowerCase() === repo.toLowerCase())
        .map((i) => ({ i, s: query ? matchScore(query, `${i.number} ${i.title}`, i.repo) || (String(i.number).startsWith(query) ? 5 : 0) : 1 }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.i)
    : [];
  let remote: GithubRefItem[] = [];
  let searched = false;
  if (repo && REPO.test(repo)) {
    const [owner, name] = repo.split("/") as [string, string];
    const auth = await resolveGithubToken(owner, name).catch(() => null);
    if (auth) {
      searched = true;
      try {
        const terms = query.replace(/[^\p{L}\p{N} ._-]/gu, " ").trim();
        const qs = encodeURIComponent(`repo:${owner}/${name} ${terms}`.trim());
        const r = await githubGet(`/search/issues?q=${qs}&per_page=${LIMIT}&sort=updated`, auth);
        checkStatus(r, "search");
        const items = (r.body as { items?: unknown[] } | null)?.items ?? [];
        remote = items.flatMap((x) => {
          const o = x as { number?: unknown; title?: unknown; state?: unknown; pull_request?: { merged_at?: unknown } | null };
          if (typeof o.number !== "number" || typeof o.title !== "string") return [];
          const pull = !!o.pull_request;
          const state = pull && o.pull_request?.merged_at ? "merged" : o.state === "closed" ? "closed" : "open";
          return [{ repo: `${owner}/${name}`, number: o.number, title: o.title, kind: pull ? ("pull" as const) : ("issues" as const), state, linked: false }];
        });
      } catch {
        partial.push("GitHub");
      }
    }
  }
  const seen = new Set<string>();
  const items = [...local, ...remote].filter((i) => {
    const k = `${i.repo.toLowerCase()}#${i.number}`;
    return !seen.has(k) && seen.add(k);
  });
  return { items: items.slice(0, LIMIT), partial, searched };
}

/** State/title of a referenced PR/issue: your linked copy first, else a read-only GET when a token covers the repo. */
export async function resolveGithubRef(
  user: CurrentUser & Capable,
  id: string,
): Promise<{ kind: "pull" | "issues"; title: string | null; state: string } | null> {
  const m = id.match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#(\d{1,9})$/);
  if (!m) return null;
  const local = can(user, "work.use") ? linkedRefs(user.id).find((i) => `${i.repo}#${i.number}`.toLowerCase() === id.toLowerCase()) : undefined;
  if (local) return { kind: local.kind, title: local.title, state: local.state };
  const auth = await resolveGithubToken(m[1]!, m[2]!).catch(() => null);
  if (!auth) return null;
  try {
    const r = await githubGet(`/repos/${m[1]}/${m[2]}/issues/${m[3]}`, auth);
    checkStatus(r, "issue");
    const b = r.body as { title?: unknown; state?: unknown; pull_request?: { merged_at?: unknown } | null };
    const pull = !!b.pull_request;
    return {
      kind: pull ? "pull" : "issues",
      title: typeof b.title === "string" ? b.title : null,
      state: pull && b.pull_request?.merged_at ? "merged" : b.state === "closed" ? "closed" : "open",
    };
  } catch {
    return null;
  }
}
