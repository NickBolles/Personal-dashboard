/**
 * Item tags and assignees (#111). Pure rules shared by the store, the API,
 * inline edits and the palette.
 *
 * Tags are lowercase slugs ("home-lab", "q4"), at most MAX_TAGS per item, created
 * on the fly. Colours come from the token palette only (TAG_COLORS), never a
 * free hex. An assignee is either an agent (a Hermes profile id, e.g.
 * momentumchief) or a person (a Jarvis user id). Assigning never starts a run:
 * it is a label for "who owns this next".
 */
import { PROFILE_NAME_RE } from "./agents";

export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;

/** Token palette keys (globals.css): accent, Tide (ai), ok, warn, bad, info. */
export const TAG_COLORS = ["ac", "ai", "ok", "wn", "bad", "inf"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export const TAG_COLOR_LABELS: Record<TagColor, string> = { ac: "Lagoon", ai: "Tide", ok: "Green", wn: "Amber", bad: "Red", inf: "Blue" };

export type WorkTag = { name: string; color: TagColor; count?: number };

/** "  Home Lab!! " → "home-lab"; returns null when nothing usable is left. */
export function normaliseTag(raw: string): string | null {
  const s = raw
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/^#+/, "")
    .replace(/[\s_/]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_TAG_LENGTH)
    .replace(/-$/, "");
  return s ? s : null;
}

export type TagsCheck = { ok: true; value: string[] } | { ok: false; error: string };

/** Normalised, de-duplicated (first wins), sorted. Too many tags is an error, not a silent cut. */
export function normaliseTags(raw: readonly string[]): TagsCheck {
  const out: string[] = [];
  for (const r of raw) {
    const t = normaliseTag(r);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) return { ok: false, error: `Keep it to ${MAX_TAGS} tags` };
  return { ok: true, value: out.sort() };
}

/** Stored form: JSON array text. Anything unreadable reads as no tags. */
export function parseTags(stored: string | null | undefined): string[] {
  if (!stored) return [];
  try {
    const v = JSON.parse(stored) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export const serialiseTags = (tags: readonly string[]) => JSON.stringify([...tags]);

/** Stable default colour for a new tag (same name → same colour). */
export function defaultTagColor(name: string): TagColor {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length]!;
}

export const isTagColor = (c: unknown): c is TagColor => typeof c === "string" && (TAG_COLORS as readonly string[]).includes(c);

// --- Assignees ---

export type Assignee = { kind: "agent"; id: string } | { kind: "person"; id: string };

/** Stored as "agent:<profile>" / "person:<userId>". */
export const assigneeRef = (a: Assignee) => `${a.kind}:${a.id}`;

export function parseAssignee(ref: string | null | undefined): Assignee | null {
  if (!ref) return null;
  const m = /^(agent|person):(.+)$/.exec(ref);
  if (!m) return null;
  return { kind: m[1] as Assignee["kind"], id: m[2]! };
}

export type AssigneeCheck = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Validates an assignee ref against what exists: `agents` = known agent profile
 * ids (registry + configured routes), `people` = active user ids. null clears it.
 */
export function validateAssignee(ref: string | null, ctx: { agents: readonly string[]; people: readonly string[] }): AssigneeCheck {
  if (ref === null || ref === "") return { ok: true, value: null };
  const a = parseAssignee(ref.trim());
  if (!a) return { ok: false, error: "Assign to an agent or a person" };
  if (a.kind === "agent") {
    const id = a.id.replace(/^@/, "").toLowerCase();
    if (!PROFILE_NAME_RE.test(id) || !ctx.agents.includes(id)) return { ok: false, error: "That agent isn't set up in Jarvis" };
    return { ok: true, value: assigneeRef({ kind: "agent", id }) };
  }
  if (!ctx.people.includes(a.id)) return { ok: false, error: "That person isn't in Settings → People" };
  return { ok: true, value: assigneeRef(a) };
}

/** Agents everyone can assign to even before routes exist (the coordinator profiles). */
export const BUILTIN_AGENTS = ["chiefofstaff", "momentumchief", "devchief", "homelabchief"] as const;

/** "@momentumchief" for agents, the person's name (or "Someone") for people. */
export function assigneeLabel(ref: string | null | undefined, people: readonly { id: string; name: string }[] = []): string | null {
  const a = parseAssignee(ref);
  if (!a) return null;
  if (a.kind === "agent") return `@${a.id}`;
  return people.find((p) => p.id === a.id)?.name ?? "Someone";
}

/** Filter predicate for lists: tag (normalised) and/or assignee ref ("none" = unassigned). */
export function matchesItemFilter(item: { tags: readonly string[]; assignee: string | null }, f: { tag?: string | null; assignee?: string | null }): boolean {
  if (f.tag) {
    const t = normaliseTag(f.tag);
    if (t && !item.tags.includes(t)) return false;
  }
  if (f.assignee) {
    if (f.assignee === "none") return !item.assignee;
    if (item.assignee !== f.assignee) return false;
  }
  return true;
}

/** "Assigned to @devchief" / "Unassigned" / "Tags: a, b → b, c" activity text. */
export function assigneeChangeText(prev: string | null, next: string | null, people: readonly { id: string; name: string }[] = []): string {
  if (!next) return `Unassigned${prev ? ` (was ${assigneeLabel(prev, people)})` : ""}`;
  return `Assigned to ${assigneeLabel(next, people)}`;
}

export function tagsChangeText(prev: readonly string[], next: readonly string[]): string {
  const added = next.filter((t) => !prev.includes(t));
  const removed = prev.filter((t) => !next.includes(t));
  const parts = [
    added.length ? `Tagged ${added.map((t) => `#${t}`).join(", ")}` : "",
    removed.length ? `Untagged ${removed.map((t) => `#${t}`).join(", ")}` : "",
  ];
  return parts.filter(Boolean).join("; ") || "Tags unchanged";
}
