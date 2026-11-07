/**
 * Areas v2 view state (N6). One URL carries the selection and the view tab:
 * `/areas?item=<id>&tab=board|activity|graph` (no `tab` = Overview). Switching
 * tabs only rewrites `tab`; selecting a node only rewrites `item`; every other
 * query parameter is kept, so a tab switch never loses the selection and a
 * re-centre never loses the tab. Pure and client-safe.
 */

/**
 * `chats` only exists for work items (leaves): it is their Chats section, folded into the one tab bar.
 * `portfolio` only exists on the all-areas landing (Phase 4: replaces the published portfolio map).
 */
export const AREA_TABS = ["overview", "portfolio", "chats", "board", "activity", "graph"] as const;
export type AreaTab = (typeof AREA_TABS)[number];

export const AREA_TAB_LABELS: Record<AreaTab, string> = {
  overview: "Overview",
  portfolio: "Portfolio",
  chats: "Chats",
  board: "Board",
  activity: "Activity",
  graph: "Graph",
};

/** Unknown, missing or legacy values fall back to Overview. */
export function parseTab(v: string | null | undefined): AreaTab {
  return (AREA_TABS as readonly string[]).includes(v ?? "") ? (v as AreaTab) : "overview";
}

/** Query keys owned by the view state (the rest of the query is left alone). */
const OWNED = ["item", "tab", "view", "do"] as const;

/**
 * The next /areas URL (path + query, no origin) for a selection and tab.
 * `item: undefined` keeps the current selection, `item: null` clears it (the
 * all-areas landing); `tab: undefined` keeps the current tab. Palette-only
 * `do` and the legacy `view` are dropped whenever the selection changes.
 */
export function areasHref(current: string | URL, next: { item?: string | null; tab?: AreaTab }): string {
  const url = new URL(typeof current === "string" ? current : current.href, "http://x");
  const cur = { item: url.searchParams.get("item"), tab: parseTab(url.searchParams.get("tab")) };
  const item = next.item === undefined ? cur.item : next.item;
  const tab = next.tab ?? cur.tab;
  const keep = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (!(OWNED as readonly string[]).includes(k)) keep.append(k, v);
  // A selection change drops palette actions and the legacy view; a pure tab switch keeps `view` (e.g. the phone tree).
  if (next.item === undefined && url.searchParams.has("view") && !item) keep.set("view", url.searchParams.get("view")!);
  const q = new URLSearchParams();
  if (item) q.set("item", item);
  if (tab !== "overview") q.set("tab", tab);
  for (const [k, v] of keep) q.append(k, v);
  const s = q.toString();
  return `/areas${s ? `?${s}` : ""}`;
}

/** Read the view state back from a URL (Back/Forward, first render). */
export function readAreasUrl(current: string | URL): { item: string | null; tab: AreaTab } {
  const url = new URL(typeof current === "string" ? current : current.href, "http://x");
  return { item: url.searchParams.get("item"), tab: parseTab(url.searchParams.get("tab")) };
}

/**
 * /areas/map (the old org-chart) → the Graph tab, keeping the rest of the
 * query: `root` becomes the selected node.
 */
export function legacyMapHref(sp: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  const root = typeof sp.root === "string" && sp.root ? sp.root : null;
  if (root) q.set("item", root);
  q.set("tab", "graph");
  for (const [k, v] of Object.entries(sp)) {
    if (k === "root" || k === "item" || k === "tab") continue;
    if (typeof v === "string") q.append(k, v);
    else if (Array.isArray(v)) for (const x of v) q.append(k, x);
  }
  return `/areas?${q}`;
}
