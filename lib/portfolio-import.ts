/**
 * Portfolio map import (Phase 4 lane 3): the published HTML portfolio map
 * (`portfolio-map.json`: projects, nodes, owner-blocked asks) is superseded by
 * Jarvis. This pure planner maps the board's JSON onto the Areas tree:
 *
 * - each board project → an existing container found by title path (Jarvis →
 *   General Dev / Jarvis, Momentum → Momentum bets, …); a project with no
 *   container gets a new project under the Portfolio area;
 * - each node → a work item under that container, its board group as a lane
 *   tag, its links as work links (https only), its status as a NON-final status
 *   (Live/Done become "ready to settle": the importer never settles);
 * - each owner-blocked ask → an item under Portfolio flagged with an owner
 *   decision, so it shows in Needs you.
 *
 * Idempotent: an item that already exists (same normalised title in the
 * container's subtree, or a word-boundary prefix match, or an explicit alias)
 * is never duplicated; it only gains missing links and tags. Nothing is ever
 * deleted, moved, renamed or re-statused, and Finance is never touched.
 * Client-safe (no server imports): the dialog previews the same plan.
 */
import { z } from "zod";
import { normaliseTag } from "./item-tags";
import { isFinanceAreaLike } from "./finance-area";
import type { WorkStatus } from "./work";

const linkPair = z.tuple([z.string().max(300), z.string().max(2000)]);
export const portfolioMapSchema = z.object({
  title: z.string().max(300).optional(),
  asOf: z.string().max(100).optional(),
  projects: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        name: z.string().min(1).max(200),
        summary: z.string().max(4000).optional(),
        links: z.array(linkPair).max(40).optional(),
      }),
    )
    .max(50),
  nodes: z
    .array(
      z.object({
        p: z.string().min(1).max(80),
        g: z.string().max(300).optional(),
        t: z.string().min(1).max(300),
        s: z.string().max(40),
        u: z.string().max(40).optional(),
        sum: z.string().max(4000).optional(),
        l: z.array(linkPair).max(40).optional(),
      }),
    )
    .max(500),
  ownerBlocked: z
    .array(z.object({ t: z.string().min(1).max(300), d: z.string().max(4000).optional(), l: z.array(linkPair).max(20).optional() }))
    .max(100)
    .optional(),
});
export type PortfolioMap = z.infer<typeof portfolioMapSchema>;

export const portfolioImportSchema = z
  .object({
    map: portfolioMapSchema,
    /** false/omitted = dry run (returns the plan, writes nothing) */
    apply: z.boolean().optional(),
    /** board node title → existing item id, for items whose titles differ (e.g. "Phase 1 · …" vs "Global coordinator …") */
    aliases: z.record(z.string().max(300), z.string().max(80)).optional(),
  })
  .strict();

/** Board project id → title path of the existing container (case-insensitive). */
export const DEFAULT_TARGETS: Record<string, string[]> = {
  jarvis: ["General Dev", "Jarvis"],
  caskfolk: ["General Dev", "Caskfolk (whiskey app)"],
  shopify: ["General Dev", "Shopify apps"],
  momentum: ["Momentum bets"],
  home: ["Home"],
};
export const PORTFOLIO_AREA = "Portfolio";
export const IMPORT_TAG = "portfolio-map";

export type ExistingItem = { id: string; parentId: string | null; kind: string; title: string; archived: boolean; tags: string[]; systemKey?: string | null };
export type ExistingLink = { itemId: string; url: string | null };

export type PlanLink = { kind: "github_pr" | "github_issue" | "url"; url: string; title: string };
export type PlanEntry = {
  /** stable within one plan: "project:<id>", "node:<n>", "ask:<n>" */
  key: string;
  action: "create" | "update" | "skip";
  kind: "project" | "thread";
  title: string;
  /** an existing container id, or the key of a container this plan creates */
  parentId?: string;
  parentKey?: string;
  /** human path of the parent, for the preview */
  parentPath: string;
  status?: WorkStatus;
  nextAction?: string;
  summary?: string;
  decision?: { question: string };
  /** create: all tags; update: only the missing ones */
  tags: string[];
  /** create: all links; update: only the missing ones */
  links: PlanLink[];
  matchedId?: string;
  reason?: string;
};
export type ImportPlan = {
  entries: PlanEntry[];
  counts: { create: number; update: number; unchanged: number; skip: number; links: number };
  /** links the board had that Jarvis can't store (file paths, non-https) */
  skippedLinks: number;
  notes: string[];
};

/** "Phase 1 · Global coordinator (LIVE)" → "Phase 1 · Global coordinator"; "Chat — 1 open" → "Chat". */
export function cleanTitle(t: string): string {
  return t
    .replace(/\s*\((LIVE|IN PROGRESS|DONE|NEXT|BLOCKED)\)\s*$/i, "")
    .replace(/\s+[—-]\s+\d+\s+open\b.*$/i, "")
    .trim();
}

/** A board node's item title: follow-up clusters ("Chat — 1 open") read "Chat follow-ups" (the count goes stale). */
export function nodeTitle(t: string): string {
  const cluster = /\s+[—-]\s+\d+\s+open\b/i.test(t);
  const c = cleanTitle(t);
  return cluster && !/follow-?ups?\b/i.test(c) ? `${c} follow-ups` : c;
}

/** Board groups that only re-count GitHub issues another group already lists. */
export const DERIVED_GROUPS = /^open issues by label/i;

/** Comparable form: case, punctuation and dash/dot separators ignored. */
export function normTitle(t: string): string {
  return cleanTitle(t)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Same title, or one is a word-boundary prefix of the other (≥ 12 chars): "Results & grading" ↔ "Results & grading rollout acceptance". */
export function titlesMatch(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 12 && l.startsWith(s + " ");
}

/** Board group → lane tag: "Master plan 2026-11-04 (rev 2 — …)" → "master-plan-2026-11-04". */
export function laneTag(group: string | undefined): string | null {
  if (!group) return null;
  const head = group.split(/\s+\(|\s+—\s+|\s+·\s+/)[0];
  return normaliseTag(head);
}

const STATUS: Record<string, WorkStatus> = {
  live: "ready_to_settle",
  done: "ready_to_settle",
  inflight: "in_progress",
  next: "ready",
  backlog: "captured",
  owner: "captured",
};
/** Board status → the item's status on create. Never a final status (settled/abandoned/superseded). */
export function mapStatus(s: string): WorkStatus {
  return STATUS[s] ?? "captured";
}

export function planLink(label: string, url: string): PlanLink | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const href = u.toString();
  const gh = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+\/?$/.exec(href);
  const title = label.trim().slice(0, 300) || u.hostname;
  if (gh) return { kind: gh[1] === "pull" ? "github_pr" : "github_issue", url: href.replace(/\/$/, ""), title };
  return { kind: "url", url: href, title };
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

function firstSentence(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const out = (m ? m[1] : t).trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** Plan an import against the owner's current tree. Pure. */
export function planPortfolioImport(
  map: PortfolioMap,
  existing: { items: ExistingItem[]; links: ExistingLink[] },
  opts: { aliases?: Record<string, string>; targets?: Record<string, string[]> } = {},
): ImportPlan {
  const targets = { ...DEFAULT_TARGETS, ...opts.targets };
  const items = existing.items.filter((i) => !i.archived);
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map<string | null, ExistingItem[]>();
  for (const i of items) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  const linksOf = new Map<string, string[]>();
  for (const l of existing.links) if (l.url) linksOf.set(l.itemId, [...(linksOf.get(l.itemId) ?? []), l.url]);
  const areaOf = (id: string): ExistingItem | undefined => {
    let cur = byId.get(id);
    for (let n = 0; cur && cur.parentId && n < 50; n++) cur = byId.get(cur.parentId);
    return cur;
  };
  const isFinance = (id: string) => {
    const a = areaOf(id);
    return !!a && isFinanceAreaLike(a);
  };
  const pathOf = (id: string): string => {
    const out: string[] = [];
    let cur = byId.get(id);
    for (let n = 0; cur && n < 50; n++) {
      out.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out.join(" / ");
  };
  const findPath = (path: string[]): ExistingItem | undefined => {
    let parent: string | null = null;
    let found: ExistingItem | undefined;
    for (const seg of path) {
      found = (kids.get(parent) ?? []).find((c) => c.kind !== "conversation" && normTitle(c.title) === normTitle(seg));
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  };
  const subtreeOf = (rootId: string): ExistingItem[] => {
    const out: ExistingItem[] = [];
    const stack = [...(kids.get(rootId) ?? [])];
    while (stack.length) {
      const i = stack.pop()!;
      if (i.kind !== "conversation") out.push(i);
      stack.push(...(kids.get(i.id) ?? []));
    }
    return out;
  };

  const entries: PlanEntry[] = [];
  const notes: string[] = [];
  let skippedLinks = 0;
  const portfolio = items.find((i) => i.parentId === null && i.kind === "area" && normTitle(i.title) === normTitle(PORTFOLIO_AREA));
  /** items this plan creates, per parent (key or id): later nodes with the same title reuse them */
  const planned = new Map<string, PlanEntry[]>();
  const note = (parent: string, e: PlanEntry) => planned.set(parent, [...(planned.get(parent) ?? []), e]);

  const links = (pairs: [string, string][] | undefined, have: string[]): PlanLink[] => {
    const out: PlanLink[] = [];
    for (const [label, url] of pairs ?? []) {
      const l = planLink(label, url);
      if (!l) {
        skippedLinks++;
        continue;
      }
      if (have.some((h) => sameUrl(h, l.url)) || out.some((o) => sameUrl(o.url, l.url))) continue;
      out.push(l);
    }
    return out;
  };
  const updateOf = (key: string, match: ExistingItem, wantTags: string[], pairs: [string, string][] | undefined, kind: PlanEntry["kind"]): PlanEntry => {
    const newLinks = links(pairs, linksOf.get(match.id) ?? []);
    const newTags = wantTags.filter((t) => !match.tags.includes(t));
    return {
      key,
      action: newLinks.length || newTags.length ? "update" : "skip",
      kind,
      title: match.title,
      parentId: match.parentId ?? undefined,
      parentPath: match.parentId ? pathOf(match.parentId) : "",
      tags: newTags,
      links: newLinks,
      matchedId: match.id,
      reason: newLinks.length || newTags.length ? undefined : "already in Jarvis",
    };
  };

  // 1. Board projects → containers.
  const containerOf = new Map<string, { id?: string; key?: string; path: string; finance?: boolean }>();
  for (const p of map.projects) {
    const key = `project:${p.id}`;
    const path = targets[p.id];
    const found = path ? findPath(path) : (portfolio && (kids.get(portfolio.id) ?? []).find((c) => titlesMatch(c.title, p.name))) || undefined;
    if (found && isFinance(found.id)) {
      containerOf.set(p.id, { path: pathOf(found.id), finance: true });
      entries.push({
        key,
        action: "skip",
        kind: "project",
        title: p.name,
        parentPath: pathOf(found.id),
        tags: [],
        links: [],
        reason: "Finance is never imported",
      });
      continue;
    }
    if (found) {
      containerOf.set(p.id, { id: found.id, path: pathOf(found.id) });
      entries.push(updateOf(key, found, [], p.links, "project"));
      continue;
    }
    if (!portfolio) {
      containerOf.set(p.id, { path: "" });
      entries.push({ key, action: "skip", kind: "project", title: p.name, parentPath: "", tags: [], links: [], reason: "No Portfolio area to put it in" });
      continue;
    }
    containerOf.set(p.id, { key, path: `${portfolio.title} / ${p.name}` });
    entries.push({
      key,
      action: "create",
      kind: "project",
      title: p.name.trim(),
      parentId: portfolio.id,
      parentPath: portfolio.title,
      status: "in_progress",
      nextAction: "Review the items imported from the portfolio map",
      summary: (p.summary ?? "").trim(),
      tags: [IMPORT_TAG],
      links: links(p.links, []),
    });
  }

  // 2. Nodes → work items.
  map.nodes.forEach((n, i) => {
    const key = `node:${i}`;
    const title = nodeTitle(n.t);
    if (n.g && DERIVED_GROUPS.test(n.g)) {
      entries.push({
        key,
        action: "skip",
        kind: "thread",
        title,
        parentPath: "",
        tags: [],
        links: [],
        reason: "derived count of GitHub issues (listed in another group)",
      });
      return;
    }
    const c = containerOf.get(n.p);
    const lane = laneTag(n.g);
    const wantTags = [IMPORT_TAG, ...(lane ? [lane] : [])];
    if (!c || c.finance || (!c.id && !c.key)) {
      entries.push({
        key,
        action: "skip",
        kind: "thread",
        title,
        parentPath: c?.path ?? "",
        tags: [],
        links: [],
        reason: c?.finance ? "Finance is never imported" : `Unknown board project "${n.p}"`,
      });
      return;
    }
    const aliasId = opts.aliases?.[n.t] ?? opts.aliases?.[title];
    const alias = aliasId ? byId.get(aliasId) : undefined;
    if (aliasId && !alias) notes.push(`Alias for "${title}" points at an item that isn't there (${aliasId}); matching by title instead.`);
    const candidates = c.id ? subtreeOf(c.id) : [];
    const matches = alias ? [alias] : candidates.filter((x) => titlesMatch(x.title, title));
    const exact = matches.filter((x) => normTitle(x.title) === normTitle(title));
    const match = alias ?? (exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined);
    if (!alias && matches.length > 1 && !exact.length)
      notes.push(`"${title}" matches ${matches.length} items; creating a new one (add an alias to link it instead).`);
    if (match && isFinance(match.id)) {
      entries.push({
        key,
        action: "skip",
        kind: "thread",
        title,
        parentPath: pathOf(match.parentId ?? match.id),
        tags: [],
        links: [],
        reason: "Finance is never imported",
      });
      return;
    }
    if (match) {
      entries.push(updateOf(key, match, wantTags, n.l, "thread"));
      return;
    }
    const parent = c.id ?? c.key!;
    const twin = (planned.get(parent) ?? []).find((e) => normTitle(e.title) === normTitle(title));
    if (twin) {
      // The board lists the same title twice (e.g. in two groups): one item, both sets of links.
      twin.links.push(
        ...links(
          n.l,
          twin.links.map((l) => l.url),
        ),
      );
      for (const t of wantTags) if (!twin.tags.includes(t) && twin.tags.length < 12) twin.tags.push(t);
      entries.push({ key, action: "skip", kind: "thread", title, parentPath: c.path, tags: [], links: [], reason: "same title as another board node; merged" });
      return;
    }
    const status = mapStatus(n.s);
    const sum = (n.sum ?? "").trim();
    const e: PlanEntry = {
      key,
      action: "create",
      kind: "thread",
      title,
      ...(c.id ? { parentId: c.id } : { parentKey: c.key }),
      parentPath: c.path,
      status,
      nextAction: status === "in_progress" || status === "ready" ? firstSentence(sum) || "Pick up from the imported notes" : "",
      summary: [sum, `Imported from the portfolio map${n.u ? ` (updated ${n.u})` : ""}; board status: ${n.s}.`].filter(Boolean).join("\n\n"),
      decision: n.s === "owner" ? { question: `${title}: what's the call?`.slice(0, 500) } : undefined,
      tags: wantTags,
      links: links(n.l, []),
    };
    note(parent, e);
    entries.push(e);
  });

  // 3. Owner-blocked asks → items with an owner decision under Portfolio.
  (map.ownerBlocked ?? []).forEach((o, i) => {
    const key = `ask:${i}`;
    const title = cleanTitle(o.t);
    if (!portfolio) {
      entries.push({ key, action: "skip", kind: "thread", title, parentPath: "", tags: [], links: [], reason: "No Portfolio area to put it in" });
      return;
    }
    const match = subtreeOf(portfolio.id).find((x) => normTitle(x.title) === normTitle(title));
    if (match) {
      entries.push(updateOf(key, match, [IMPORT_TAG, "owner-ask"], o.l, "thread"));
      return;
    }
    entries.push({
      key,
      action: "create",
      kind: "thread",
      title,
      parentId: portfolio.id,
      parentPath: portfolio.title,
      status: "captured",
      nextAction: "",
      summary: [(o.d ?? "").trim(), "Imported from the portfolio map's “Blocked on you” list."].filter(Boolean).join("\n\n"),
      decision: { question: title.slice(0, 500) },
      tags: [IMPORT_TAG, "owner-ask"],
      links: links(o.l, []),
    });
  });

  const counts = { create: 0, update: 0, unchanged: 0, skip: 0, links: 0 };
  for (const e of entries) {
    if (e.action === "create") counts.create++;
    else if (e.action === "update") counts.update++;
    else if (e.matchedId) counts.unchanged++;
    else counts.skip++;
    if (e.action !== "skip") counts.links += e.links.length;
  }
  return { entries, counts, skippedLinks, notes };
}
