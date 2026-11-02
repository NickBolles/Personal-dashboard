/**
 * Raycast-style palette: typed actions with inline argument chips.
 *
 * Pure (no React, no fetch) so parsing, chip filling and suggestion ranking are
 * unit-tested (test/palette.test.ts). The dialog (components/search/SearchDialog.tsx)
 * keeps a `{ action, chips, input }` state and asks this module what to show.
 *
 * Writes (new item, move, assign, set status, archive) are ALWAYS confirmed by
 * a second, explicit step; settling is never offered here (it has its own
 * flow on the item page), so no status list contains a closing status.
 */
import { matchScore } from "@/lib/search";
import { STATUS_LABELS, type WorkStatus } from "@/lib/work";
import { normaliseTag } from "@/lib/item-tags";

export type ArgKind = "area" | "item" | "agent" | "status" | "pr" | "text" | "assignee" | "tag";
export type ArgSpec = { kind: ArgKind; name: string; /** word typed before this argument ("to", "in") */ joiner?: string };

export type ActionId = "new-item" | "ask" | "move" | "assign" | "status" | "open-pr" | "chat-agent" | "assign-item" | "tag";

export type ActionDef = {
  id: ActionId;
  /** row label before the chips, e.g. "New item in" */
  label: string;
  /** phrases that start this action when typed (lower case, longest first) */
  phrases: string[];
  /** `/` command name */
  slash: string;
  args: ArgSpec[];
  /** changes data → a confirm step before it runs */
  write: boolean;
  /** needs the item/area you're on (filled from context, not typed) */
  needs?: "item" | "area";
};

export const ACTIONS: ActionDef[] = [
  {
    id: "new-item",
    label: "New item in",
    phrases: ["new item in", "new item", "add item to", "add item", "add to", "create item in", "create item"],
    slash: "new",
    args: [
      { kind: "area", name: "Area" },
      { kind: "text", name: "Title" },
    ],
    write: true,
  },
  {
    id: "ask",
    label: "Ask",
    phrases: ["ask"],
    slash: "ask",
    args: [
      { kind: "area", name: "Area" },
      { kind: "text", name: "Question" },
    ],
    write: false,
  },
  {
    id: "move",
    label: "Move",
    phrases: ["move", "file"],
    slash: "move",
    args: [
      { kind: "item", name: "Item" },
      { kind: "area", name: "Area", joiner: "to" },
    ],
    write: true,
  },
  /** #111: the item's assignee (agent or person); a label only, never starts a run */
  {
    id: "assign-item",
    label: "Assign to",
    phrases: ["assign to", "assign"],
    slash: "assignee",
    args: [{ kind: "assignee", name: "Agent or person" }],
    write: true,
    needs: "item",
  },
  { id: "assign", label: "Assign to", phrases: ["assign to", "assign"], slash: "assign", args: [{ kind: "agent", name: "Agent" }], write: true, needs: "area" },
  {
    id: "status",
    label: "Set status",
    phrases: ["set status to", "set status", "status"],
    slash: "status",
    args: [{ kind: "status", name: "Status" }],
    write: true,
    needs: "item",
  },
  { id: "tag", label: "Tag", phrases: ["tag with", "tag as", "tag"], slash: "tag", args: [{ kind: "tag", name: "#tag" }], write: true, needs: "item" },
  { id: "open-pr", label: "Open PR", phrases: ["open pr", "pr"], slash: "pr", args: [{ kind: "pr", name: "#" }], write: false },
  {
    id: "chat-agent",
    label: "Start chat with",
    phrases: ["start chat with", "chat with", "message"],
    slash: "chat",
    args: [{ kind: "agent", name: "@agent" }],
    write: false,
  },
];

export const actionById = (id: ActionId) => ACTIONS.find((a) => a.id === id)!;

/** Statuses the palette may set: never settled/closing ones and never "ready to settle" (settling is a person's decision on the item page). */
// #104: no "reopened" — the server requires a reason for it, so reopening goes through the item page's Reopen.
export const PALETTE_STATUSES: WorkStatus[] = ["captured", "exploring", "ready", "in_progress", "in_review", "awaiting_validation", "on_hold"];

export type Candidate = { id: string; label: string; detail?: string };
export type Chip = { arg: ArgSpec; value: Candidate };

export type PaletteContext = {
  areas: Candidate[];
  items: Candidate[];
  agents: Candidate[];
  /** #111: "agent:<profile>" / "person:<id>" refs */
  assignees?: Candidate[];
  /** #111: existing tag names */
  tags?: Candidate[];
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trimStart();

export type TypedMatch = {
  def: ActionDef;
  /** text after the phrase: the argument fragments */ rest: string;
  /** the phrase was typed in full */ exact: boolean;
};

/**
 * Typed actions matching the query: "new item in ho" → New item in (rest "ho");
 * "new it" → New item in (prefix, rest ""). "/" lists every action, "/mo" filters by
 * command name. Context-bound actions are left out when there's nothing to act on.
 */
export function matchActions(q: string, has: { item?: boolean; area?: boolean } = {}): TypedMatch[] {
  const usable = ACTIONS.filter((a) => !a.needs || has[a.needs]);
  const raw = norm(q);
  // #103: match on the lowercased query, but slice arguments from the typed text so
  // "new item in Home Fix API_KEY" keeps its casing (falls back when lowercasing changed lengths)
  const typed = q.replace(/\s+/g, " ").trimStart();
  const orig = typed.length === raw.length ? typed : raw;
  if (raw.startsWith("/")) {
    const [cmd = ""] = raw.slice(1).split(" ");
    const sp = raw.indexOf(" ");
    const rest = sp < 0 ? "" : orig.slice(sp + 1);
    return usable.filter((a) => a.slash.startsWith(cmd)).map((def) => ({ def, rest, exact: def.slash === cmd && raw.includes(" ") }));
  }
  if (!raw.trim()) return [];
  const out: TypedMatch[] = [];
  for (const def of usable) {
    let hit: TypedMatch | null = null;
    for (const p of def.phrases) {
      if (raw === p || raw.startsWith(`${p} `)) {
        hit = { def, rest: orig.slice(p.length).trimStart(), exact: true };
        break;
      }
      // only prefixes of 2+ letters, so a single "a" doesn't list half the actions
      if (raw.trim().length >= 2 && p.startsWith(raw.trimEnd()) && !hit) hit = { def, rest: "", exact: false };
    }
    if (hit) out.push(hit);
  }
  return out.sort((x, y) => Number(y.exact) - Number(x.exact));
}

/**
 * Split an action's remainder into one fragment per argument, at each joiner word:
 * Move "hydration fix to momentum" → ["hydration fix", "momentum"]. Arguments
 * filled from context are skipped by the caller (pass the remaining specs).
 */
export function splitArgs(args: ArgSpec[], rest: string): string[] {
  const out: string[] = [];
  let tail = rest;
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (next?.joiner) {
      const m = new RegExp(`(^|\\s)${next.joiner}(\\s|$)`, "i").exec(tail);
      if (m) {
        out.push(tail.slice(0, m.index).trim());
        tail = tail.slice(m.index + m[0].length);
        continue;
      }
      out.push(tail.trim());
      tail = "";
      continue;
    }
    // a choice argument followed by free text: the first word picks, the rest is the text (Tab fills the chip)
    if (next?.kind === "text" && args[i]!.kind !== "text") {
      out.push(tail.trim());
      tail = "";
      continue;
    }
    out.push(tail.trim());
    tail = "";
  }
  return out;
}

/** The argument the person is filling now (first unfilled one), or null when all are filled. */
export function currentArg(def: ActionDef, chips: Chip[]): ArgSpec | null {
  return def.args[chips.length] ?? null;
}

/** Candidates for a choice argument, best match first (empty fragment → all, in given order). */
export function candidatesFor(kind: ArgKind, fragment: string, ctx: PaletteContext, limit = 8): Candidate[] {
  const f = fragment.trim().replace(/^[@#]/, "");
  let list: Candidate[];
  if (kind === "area") list = ctx.areas;
  else if (kind === "item") list = ctx.items;
  else if (kind === "agent") list = ctx.agents;
  else if (kind === "assignee") list = ctx.assignees ?? [];
  else if (kind === "tag") {
    const known = ctx.tags ?? [];
    const t = normaliseTag(f);
    const create = t && !known.some((c) => c.id === t) ? [{ id: t, label: `#${t}`, detail: "New tag" }] : [];
    if (!f) return known.slice(0, limit);
    const hits = known
      .map((c, i) => ({ c, s: matchScore(f, c.label, c.detail), i }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.i - y.i)
      .map((x) => x.c);
    return [...hits, ...create].slice(0, limit);
  } else if (kind === "status") list = PALETTE_STATUSES.map((s) => ({ id: s, label: STATUS_LABELS[s] }));
  else if (kind === "pr") {
    const n = /^\d{1,7}$/.exec(f)?.[0];
    return n ? [{ id: n, label: `#${n}` }] : [];
  } else return [];
  if (!f) return list.slice(0, limit);
  return list
    .map((c, i) => ({ c, s: matchScore(f, c.label, c.detail), i }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * Tab: fill the current argument's chip with the best candidate for what's typed.
 * Returns the new chips + leftover input, or null when nothing fits (Tab then does nothing).
 */
export function fillChip(def: ActionDef, chips: Chip[], input: string, ctx: PaletteContext, pick?: Candidate): { chips: Chip[]; input: string } | null {
  const arg = currentArg(def, chips);
  if (!arg) return null;
  if (arg.kind === "text") {
    const t = input.trim();
    return t ? { chips: [...chips, { arg, value: { id: t, label: t } }], input: "" } : null;
  }
  const remaining = def.args.slice(chips.length);
  const [frag = "", ...more] = splitArgs(remaining, input);
  const best = pick ?? candidatesFor(arg.kind, frag, ctx, 1)[0];
  if (!best) return null;
  const next = remaining[1];
  const leftover = next?.joiner ? more.join(" ") : next?.kind === "text" ? "" : more.join(" ");
  return { chips: [...chips, { arg, value: best }], input: leftover };
}

/** Everything typed in one go ("new item in home Fix gutter", "move gutter to home"): fill as many chips as resolve. */
export function fillAll(def: ActionDef, rest: string, ctx: PaletteContext): { chips: Chip[]; input: string } {
  let chips: Chip[] = [];
  let input = rest.trim();
  const all = (k: ArgKind) => candidatesFor(k, "", ctx, 10_000);
  const exact = (k: ArgKind, t: string) => all(k).find((c) => c.label.toLowerCase() === t.trim().toLowerCase());
  while (input) {
    const arg = currentArg(def, chips);
    if (!arg || arg.kind === "text") break;
    const next = def.args[chips.length + 1];
    if (next?.kind === "text") {
      // the longest leading run of words naming a candidate; the rest is the text
      const words = input.split(" ");
      let n = words.length;
      for (; n >= 1 && !exact(arg.kind, words.slice(0, n).join(" ")); n--);
      if (!n) break;
      chips = [...chips, { arg, value: exact(arg.kind, words.slice(0, n).join(" "))! }];
      input = words.slice(n).join(" ");
    } else if (next?.joiner) {
      const frags = splitArgs(def.args.slice(chips.length), input);
      if (!new RegExp(`(^|\\s)${next.joiner}(\\s|$)`, "i").test(input)) break;
      const hit = exact(arg.kind, frags[0] ?? "") ?? candidatesFor(arg.kind, frags[0] ?? "", ctx, 1)[0];
      if (!hit) break;
      chips = [...chips, { arg, value: hit }];
      input = frags[1] ?? "";
    } else {
      // after a joiner ("… to momentum") the best match is meant; a bare last word stays typed text until Tab
      const hit = exact(arg.kind, input) ?? (arg.kind === "pr" || arg.joiner ? candidatesFor(arg.kind, input, ctx, 1)[0] : undefined);
      if (!hit) break;
      chips = [...chips, { arg, value: hit }];
      input = "";
    }
  }
  return { chips, input };
}

/** All arguments filled → ready to confirm (write) or run. */
export const isComplete = (def: ActionDef, chips: Chip[]) => chips.length >= def.args.length;

/** The sentence a confirm step shows: "Create “Fix gutter” in Home?" */
export function confirmText(def: ActionDef, chips: Chip[], here?: { title: string } | null) {
  const v = (i: number) => chips[i]?.value.label ?? "…";
  switch (def.id) {
    case "new-item":
      return `Create “${v(1)}” in ${v(0)}?`;
    case "move":
      return `Move “${v(0)}” to ${v(1)}?`;
    case "assign":
      return `Assign ${here?.title ?? "this area"} to ${v(0)}?`;
    case "status":
      return `Set ${here ? `“${here.title}”` : "this item"} to ${v(0)}?`;
    case "assign-item":
      return `Assign ${here ? `“${here.title}”` : "this item"} to ${v(0)}?`;
    case "tag":
      return `Tag ${here ? `“${here.title}”` : "this item"} ${v(0)}?`;
    default:
      return `${def.label} ${chips.map((c) => c.value.label).join(" ")}`;
  }
}

/* ---------------- suggestions ---------------- */

export type Here = { kind: "item" | "area" | "chat" | "page"; path: string; nodeTitle?: string; areaTitle?: string; isContainer?: boolean };
export type Suggestion = { id: string; action?: ActionId; label: string; score: number };

/**
 * Root-list Suggestions for where you are: on an item → Set status, Move, Ask its area;
 * on an area/project → New item in it, Ask it, Assign; in chat → Start chat with @;
 * elsewhere → New item, Ask, Open PR. Recently used actions get a boost (max 6 shown).
 */
export function rankSuggestions(here: Here, recent: string[] = [], has: { item?: boolean; area?: boolean } = {}): Suggestion[] {
  const base: Record<ActionId, number> = {
    "new-item": 50,
    ask: 45,
    move: 20,
    assign: 10,
    status: 15,
    "open-pr": 25,
    "chat-agent": 30,
    "assign-item": 12,
    tag: 12,
  };
  if (here.kind === "item") Object.assign(base, { status: 80, move: 75, ask: 70, "new-item": 30, "assign-item": 65, tag: 60 });
  if (here.kind === "area") Object.assign(base, { "new-item": 85, ask: 80, assign: 60 });
  if (here.kind === "chat") Object.assign(base, { "chat-agent": 85, "new-item": 40 });
  if (here.path.startsWith("/inbox")) Object.assign(base, { move: 85 });
  const scored = ACTIONS.filter((a) => !a.needs || has[a.needs]).map((def) => {
    const r = recent.indexOf(def.id);
    const where =
      def.id === "new-item" || def.id === "ask" ? (here.kind === "area" ? here.nodeTitle : here.kind === "item" ? here.areaTitle : undefined) : undefined;
    return {
      id: `sugg:${def.id}`,
      action: def.id,
      label: where ? `${def.label} ${where}` : def.label,
      score: base[def.id] + (r >= 0 ? 30 - r * 5 : 0),
    };
  });
  return scored.sort((x, y) => y.score - x.score).slice(0, 6);
}

/* ---------------- recent ---------------- */

export const RECENT_KEY = "jarvis.palette.recent";
export type RecentEntry = { id: string; title: string; href?: string; action?: ActionId; at: number };

/** Most recent first, deduped by id, capped. */
export function pushRecent(list: RecentEntry[], e: RecentEntry, cap = 8): RecentEntry[] {
  return [e, ...list.filter((x) => x.id !== e.id)].slice(0, cap);
}

/* ---------------- open PR ---------------- */

/** GitHub search for a PR number (fallback when no linked/known PR matches). */
export function prSearchUrl(n: string): string {
  return `https://github.com/search?q=${encodeURIComponent(`#${n}`)}&type=pullrequests`;
}

/**
 * URL for "Open PR #n" from the `#` picker options (`id` = "owner/repo#n", detail
 * "PR · open · linked"): a PR linked to your work wins, then any PR, then an issue
 * with that number; otherwise GitHub search.
 */
export function prUrlFor(n: string, options: { id: string; detail?: string }[]): string {
  const hits = options
    .map((o) => ({ o, m: /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(o.id) }))
    .filter((x): x is { o: { id: string; detail?: string }; m: RegExpExecArray } => !!x.m && x.m[2] === n);
  const score = (d = "") => (d.startsWith("PR") ? 2 : 0) + (d.includes("linked") ? 4 : 0);
  const best = hits.sort((a, b) => score(b.o.detail) - score(a.o.detail))[0];
  if (!best) return prSearchUrl(n);
  return `https://github.com/${best.m[1]}/${best.o.detail?.startsWith("Issue") ? "issues" : "pull"}/${n}`;
}
