/**
 * Automatic, read-only GitHub refresh rules (docs/work.md). Pure: the store
 * asks which links are due, claims them, reads GitHub with bounded
 * parallelism and applies each result through setLinkState, which is a no-op
 * when the state didn't change, so a merge transition happens exactly once.
 */

/** At most one automatic readback per link per 5 minutes. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;
/** At most this many links are read per request. */
export const REFRESH_MAX_PER_REQUEST = 10;
/** At most this many GitHub requests in flight at once. */
export const REFRESH_PARALLELISM = 4;

export type RefreshCandidate = {
  id: string;
  kind: string;
  url: string | null;
  externalState: string | null;
  checkedAt: string | null;
};

/** A merged PR never changes again; everything else can (closed PRs and issues reopen). */
export function isFinalState(l: Pick<RefreshCandidate, "kind" | "externalState">) {
  return l.kind === "github_pr" && l.externalState === "merged";
}

/**
 * Links due for an automatic readback: GitHub PRs/issues with a URL, not in a
 * final state, never checked or last checked at least `intervalMs` ago.
 * Oldest check first (never-checked first), then id; capped at `max`.
 */
export function dueForRefresh(links: RefreshCandidate[], now: Date, opts: { intervalMs?: number; max?: number } = {}): string[] {
  const interval = opts.intervalMs ?? REFRESH_INTERVAL_MS;
  const max = opts.max ?? REFRESH_MAX_PER_REQUEST;
  const t = now.getTime();
  return links
    .filter((l) => (l.kind === "github_pr" || l.kind === "github_issue") && !!l.url && !isFinalState(l))
    .filter((l) => !l.checkedAt || t - new Date(l.checkedAt).getTime() >= interval)
    .sort((a, b) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "") || a.id.localeCompare(b.id))
    .slice(0, max)
    .map((l) => l.id);
}

/** The cutoff a claim compares against: a link last checked before it may be checked again. */
export function claimCutoff(now: Date, intervalMs = REFRESH_INTERVAL_MS) {
  return new Date(now.getTime() - intervalMs).toISOString();
}
