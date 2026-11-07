import { bucketOf } from "./map-rollup";
import { isClosed, isContainer, type WorkItem } from "./work";

export type DigestRow = {
  id: string;
  title: string;
  path: string;
  reason: "needs_you" | "overdue" | "next" | "inflight";
  nextAction: string;
  updatedAt: string;
};

/** A small, deterministic portfolio digest; totals are before the five-row cap. */
export function digest(items: WorkItem[], today: string): { inflight: DigestRow[]; outstanding: DigestRow[]; inflightTotal: number; outstandingTotal: number } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const path = (i: WorkItem) => {
    const titles: string[] = [];
    const seen = new Set([i.id]);
    for (let p = i.parentId ? byId.get(i.parentId) : undefined; p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
      seen.add(p.id);
      if (isContainer(p) && p.kind !== "conversation") titles.unshift(p.title);
    }
    return titles.join(" · ");
  };
  const inflight: DigestRow[] = [];
  const outstanding: DigestRow[] = [];
  for (const i of items) {
    if (i.archived || isContainer(i) || i.kind === "conversation" || isClosed(i.status)) continue;
    const bucket = bucketOf(i);
    const row = { id: i.id, title: i.title, path: path(i), nextAction: i.nextAction, updatedAt: i.updatedAt };
    if (bucket === "inflight") inflight.push({ ...row, reason: "inflight" });
    const reason = bucket === "owner" ? "needs_you" : i.targetDate && i.targetDate < today ? "overdue" : bucket === "next" ? "next" : null;
    if (reason) outstanding.push({ ...row, reason });
  }
  const newest = (a: DigestRow, b: DigestRow) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  const rank: Record<DigestRow["reason"], number> = { needs_you: 0, overdue: 1, next: 2, inflight: 3 };
  inflight.sort(newest);
  outstanding.sort((a, b) => rank[a.reason] - rank[b.reason] || newest(a, b));
  return { inflight: inflight.slice(0, 5), outstanding: outstanding.slice(0, 5), inflightTotal: inflight.length, outstandingTotal: outstanding.length };
}

/**
 * Aggregate each edge once, bottom-up (O(n)), including work nested under work
 * or conversations but not the conversations themselves. Archived branches are
 * disconnected, as in work.rollup. Cyclic edges are not traversed repeatedly.
 */
export function treeCounts(items: WorkItem[]): Map<string, { owner: number; inflight: number; open: number }> {
  const live = items.filter((i) => !i.archived);
  const byId = new Map(live.map((i) => [i.id, i]));
  const pending = new Map(live.map((i) => [i.id, 0]));
  const totals = new Map<string, { owner: number; inflight: number; open: number }>(
    live.map((i) => {
      const work = !isContainer(i) && i.kind !== "conversation" && !isClosed(i.status);
      return [i.id, { owner: work && bucketOf(i) === "owner" ? 1 : 0, inflight: work && bucketOf(i) === "inflight" ? 1 : 0, open: work ? 1 : 0 }] as const;
    }),
  );
  for (const i of live) if (i.parentId && byId.has(i.parentId)) pending.set(i.parentId, pending.get(i.parentId)! + 1);
  const queue = live.filter((i) => pending.get(i.id) === 0);
  for (let n = 0; n < queue.length; n++) {
    const i = queue[n];
    if (!i.parentId || !byId.has(i.parentId)) continue;
    const own = totals.get(i.id)!;
    const parent = totals.get(i.parentId)!;
    parent.owner += own.owner;
    parent.inflight += own.inflight;
    parent.open += own.open;
    const left = pending.get(i.parentId)! - 1;
    pending.set(i.parentId, left);
    if (left === 0) queue.push(byId.get(i.parentId)!);
  }
  return new Map(live.filter(isContainer).map((i) => [i.id, totals.get(i.id)!]));
}
