/**
 * Portfolio view (Phase 4, replaces the published portfolio map board): one
 * row per project across every area, its open work in status lanes (Blocked on
 * you · In flight · Next · Live · Backlog; Done as a count), board/PR links and
 * the latest update. Pure and client-safe.
 */
import { bucketOf, emptyCounts, type BucketCounts, type MapBucket } from "./map-rollup";
import { isFinanceAreaLike } from "./finance-area";
import { isContainer, type WorkItem } from "./work";

export const PORTFOLIO_LANES = ["owner", "inflight", "next", "live", "backlog"] as const satisfies readonly MapBucket[];
export type PortfolioLane = (typeof PORTFOLIO_LANES)[number];

type Item = Pick<WorkItem, "id" | "parentId" | "kind" | "title" | "status" | "archived" | "decision" | "updatedAt" | "tags" | "nextAction"> & {
  systemKey?: string | null;
};

export type PortfolioRow = {
  id: string;
  title: string;
  /** "General Dev" for General Dev / Jarvis; "" for an area row */
  path: string;
  areaId: string;
  lanes: Record<PortfolioLane, Item[]>;
  counts: BucketCounts;
  open: number;
  updatedAt: string;
};

/** Nearest container (project or area) above an item; null for an area. */
function containerOf(i: Item, byId: Map<string, Item>): Item | null {
  let cur = i.parentId ? byId.get(i.parentId) : undefined;
  for (let n = 0; cur && n < 50; n++) {
    if (isContainer(cur)) return cur;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

/**
 * Rows for every project (and every area that holds work directly), Finance
 * left out, ordered: rows waiting on you first, then by open work, then by
 * latest update. `tag` keeps only items carrying that tag (rows with none drop).
 */
export function portfolioRows(source: Item[], opts: { tag?: string } = {}): PortfolioRow[] {
  const items = source.filter((i) => !i.archived && i.kind !== "conversation");
  const byId = new Map(items.map((i) => [i.id, i]));
  const areaOf = (i: Item): Item | undefined => {
    let cur: Item | undefined = i;
    for (let n = 0; cur && cur.parentId && n < 50; n++) cur = byId.get(cur.parentId);
    return cur && cur.parentId === null ? cur : undefined;
  };
  const rows = new Map<string, PortfolioRow>();
  const rowFor = (c: Item): PortfolioRow | null => {
    const area = areaOf(c);
    if (!area || isFinanceAreaLike(area)) return null;
    let r = rows.get(c.id);
    if (!r) {
      const path: string[] = [];
      let p = c.parentId ? byId.get(c.parentId) : undefined;
      for (let n = 0; p && n < 50; n++) {
        path.unshift(p.title);
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
      r = {
        id: c.id,
        title: c.title,
        path: path.join(" / "),
        areaId: area.id,
        lanes: { owner: [], inflight: [], next: [], live: [], backlog: [] },
        counts: emptyCounts(),
        open: 0,
        updatedAt: c.updatedAt,
      };
      rows.set(c.id, r);
    }
    return r;
  };
  for (const i of items) {
    if (isContainer(i)) continue;
    if (opts.tag && !i.tags.includes(opts.tag)) continue;
    const c = containerOf(i, byId);
    if (!c) continue;
    const r = rowFor(c);
    if (!r) continue;
    const b = bucketOf(i);
    r.counts[b]++;
    if (b !== "done") {
      r.lanes[b].push(i);
      r.open++;
    }
    if (i.updatedAt > r.updatedAt) r.updatedAt = i.updatedAt;
  }
  for (const r of rows.values())
    for (const l of PORTFOLIO_LANES) r.lanes[l].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return [...rows.values()]
    .filter((r) => r.open + r.counts.done > 0)
    .sort((a, b) => b.counts.owner - a.counts.owner || b.open - a.open || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Tags on open work in the portfolio (for the lane/group filter), most used first. */
export function portfolioTags(source: Item[]): string[] {
  const n = new Map<string, number>();
  for (const i of source) if (!i.archived && i.kind !== "conversation" && !isContainer(i)) for (const t of i.tags) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** "b4c633fbd8…" → "b4c633f"; anything that isn't a hex SHA is shown as is. */
export function shortVersion(v: string): string {
  return /^[0-9a-f]{7,40}$/i.test(v) ? v.slice(0, 7) : v;
}
