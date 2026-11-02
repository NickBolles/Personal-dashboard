/**
 * Map overview (/map): status buckets and per-area rollups, matching the
 * portfolio board's language (Live / In flight / Next / Backlog / Blocked on
 * you / Done). Pure and client-safe.
 */
import { isContainer, type WorkItem, type WorkStatus } from "./work";

export const MAP_BUCKETS = ["owner", "inflight", "next", "live", "backlog", "done"] as const;
export type MapBucket = (typeof MAP_BUCKETS)[number];

export const MAP_BUCKET_LABELS: Record<MapBucket, string> = {
  owner: "Blocked on you",
  inflight: "In flight",
  next: "Next",
  live: "Live",
  backlog: "Backlog",
  done: "Done",
};

const STATUS_BUCKET: Record<WorkStatus, Exclude<MapBucket, "owner">> = {
  captured: "backlog",
  exploring: "backlog",
  on_hold: "backlog",
  ready: "next",
  in_progress: "inflight",
  in_review: "inflight",
  reopened: "inflight",
  awaiting_validation: "live",
  ready_to_settle: "live",
  settled: "done",
  superseded: "done",
  abandoned: "done",
};

/** An open owner decision beats the status: the item waits on you whatever its lane. */
export function bucketOf(i: Pick<WorkItem, "status" | "decision">): MapBucket {
  const b = STATUS_BUCKET[i.status] ?? "backlog";
  if (i.decision && b !== "done") return "owner";
  return b;
}

export type BucketCounts = Record<MapBucket, number>;
export const emptyCounts = (): BucketCounts => ({ owner: 0, inflight: 0, next: 0, live: 0, backlog: 0, done: 0 });

export type AreaRollup = {
  id: string;
  title: string;
  counts: BucketCounts;
  total: number;
  projects: number;
  lastActivity: string | null;
};

type RollItem = Pick<WorkItem, "id" | "parentId" | "kind" | "status" | "archived" | "decision" | "updatedAt" | "title">;

/** Top-level area of every item (walks parent links; cycles and orphans map to null). */
export function areaIndex(items: RollItem[]): Map<string, string | null> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map<string, string | null>();
  for (const i of items) {
    let cur: RollItem | undefined = i;
    const seen = new Set<string>();
    while (cur && cur.parentId !== null && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    out.set(i.id, cur && cur.parentId === null ? cur.id : null);
  }
  return out;
}

/**
 * One rollup per area: counts of its non-container work items (projects are
 * groups, not work), project count and the latest update in the subtree.
 * Archived items and conversations are left out (conversations aren't work).
 */
export function areaRollups(items: RollItem[]): AreaRollup[] {
  const live = items.filter((i) => !i.archived);
  const areaOf = areaIndex(live);
  const rolls = new Map<string, AreaRollup>();
  for (const a of live.filter((i) => i.parentId === null))
    rolls.set(a.id, { id: a.id, title: a.title, counts: emptyCounts(), total: 0, projects: 0, lastActivity: a.updatedAt });
  for (const i of live) {
    if (i.parentId === null) continue;
    const r = rolls.get(areaOf.get(i.id) ?? "");
    if (!r) continue;
    if (!r.lastActivity || i.updatedAt > r.lastActivity) r.lastActivity = i.updatedAt;
    if (i.kind === "conversation") continue;
    if (isContainer(i)) {
      r.projects++;
      continue;
    }
    r.counts[bucketOf(i)]++;
    r.total++;
  }
  return [...rolls.values()];
}

export type MapFilter = { area?: string; bucket?: MapBucket; tag?: string; assignee?: string; q?: string };

/** Does a work item match the filter chips? (Containers are shown when any descendant matches.) */
export function matchesFilter(i: Pick<WorkItem, "title" | "nextAction" | "summary" | "status" | "decision" | "tags" | "assignee">, f: MapFilter): boolean {
  if (f.bucket && bucketOf(i) !== f.bucket) return false;
  if (f.tag && !i.tags.includes(f.tag)) return false;
  if (f.assignee && (f.assignee === "none" ? i.assignee !== null : i.assignee !== f.assignee)) return false;
  const q = f.q?.trim().toLowerCase();
  if (q && ![i.title, i.nextAction, i.summary].some((t) => t.toLowerCase().includes(q))) return false;
  return true;
}

export type MapExport = {
  version: 1;
  exportedAt: string;
  areas: (AreaRollup & { tree: MapExportNode[] })[];
};
export type MapExportNode = {
  id: string;
  title: string;
  kind: string;
  status: string;
  bucket: MapBucket;
  nextAction: string;
  tags: string[];
  assignee: string | null;
  decision: WorkItem["decision"];
  links: { kind: string; url: string; title: string | null }[];
  children: MapExportNode[];
};
