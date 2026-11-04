/**
 * Unified activity timeline: one normalised row shape for work_events, work_ops (undo),
 * Inbox filing and chat runs, plus day grouping and an opaque (at, id) cursor.
 * Pure (no server imports) so the client and unit tests share it.
 */
import { STATUS_LABELS, type WorkStatus } from "@/lib/work";
import { localDate } from "@/lib/time";

export const ACTIVITY_TYPES = ["edit", "status", "created", "structure", "link", "github", "capture", "chat", "validation", "chore"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  edit: "Edits",
  status: "Status",
  created: "Created",
  structure: "Moves & forks",
  link: "Links",
  github: "GitHub",
  capture: "Inbox",
  chat: "Chats & runs",
  validation: "Validations",
  chore: "Chores",
};

export type ActorKind = "you" | "agent" | "github" | "system";
export const ACTOR_LABELS: Record<ActorKind, string> = { you: "You", agent: "Agent", github: "GitHub", system: "Jarvis" };

export type ActivityItem = {
  id: string;
  at: string;
  type: ActivityType;
  actor: { kind: ActorKind; name: string };
  verb: string;
  object: { id: string; title: string } | null;
  detail: string | null;
  /** a work_ops id the viewer can still undo (latest of its stack, inside the window) */
  undoOpId: string | null;
  /**
   * Server-only insertion order (SQLite rowid) for rows that share a millisecond: two quick edits
   * often do, and their random ids would order them arbitrarily. Stripped from API responses.
   */
  seq?: number;
};

export type ActivityResponse = { items: ActivityItem[]; nextCursor: string | null; latestAt: string | null };

export type RawWorkEvent = {
  id: string;
  itemId: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  actor: string;
  source: string | null;
  at: string;
};

const STRUCTURE = new Set(["moved", "move", "reorder", "reordered", "archived", "unarchived", "split", "fork", "forked", "handoff", "restored"]);

/** Who did it: the signed-in viewer's id → "you"; GitHub refresh → github; agent/hermes ids → agent. */
export function actorFor(actor: string, source: string | null, viewerId: string, agentName = "Hermes"): ActivityItem["actor"] {
  if (source === "github" || actor === "github") return { kind: "github", name: "GitHub" };
  if (actor === viewerId) return { kind: "you", name: "You" };
  if (/^(agent|hermes|ai|claude|codex)(:|$)/i.test(actor)) {
    const name = actor.includes(":") ? actor.split(":").slice(1).join(":") : agentName;
    return { kind: "agent", name: name || agentName };
  }
  if (actor === "system" || actor === "jarvis" || actor === "auto") return { kind: "system", name: "Jarvis" };
  return { kind: "you", name: "Someone" };
}

const label = (s: string | null) => (s ? (STATUS_LABELS[s as WorkStatus] ?? s) : "—");

/** One work_events row → a timeline row. */
export function normalizeWorkEvent(e: RawWorkEvent, viewerId: string, title: string | null): ActivityItem {
  const actor = actorFor(e.actor, e.source, viewerId);
  const object = { id: e.itemId, title: title ?? "Untitled" };
  let type: ActivityType = "edit";
  let verb = e.reason ?? e.kind;
  let detail: string | null = null;
  if (e.kind === "status") {
    type = "status";
    verb = `moved to ${label(e.toStatus)}`;
    // The note reads as a sentence after the transition ("In progress → Awaiting validation: PR #12 merged").
    detail = `${label(e.fromStatus)} → ${label(e.toStatus)}${e.reason ? `: ${e.reason}` : ""}`;
  } else if (e.kind === "created") {
    type = "created";
    verb = "created";
    detail = e.reason;
  } else if (e.kind === "merged" || e.kind === "closed") {
    type = "github";
    verb = e.kind === "merged" ? "PR merged on" : "PR closed on";
    detail = e.reason;
  } else if (e.kind === "link") {
    type = "link";
    verb = "linked";
    detail = e.reason;
  } else if (e.kind === "validation") {
    type = "validation";
    verb = "validation";
    detail = e.reason;
  } else if (e.kind === "packet") {
    type = "edit";
    verb = "updated the packet on";
    detail = e.reason;
  } else if (e.kind === "decision") {
    // Decisions inbox: "Decision: <question> → <answer>"
    type = "edit";
    verb = "decided on";
    detail = e.reason;
  } else if (STRUCTURE.has(e.kind)) {
    type = "structure";
    verb = e.kind === "archived" ? "archived" : e.kind === "unarchived" ? "unarchived" : (e.reason ?? e.kind);
    detail = e.kind === "archived" || e.kind === "unarchived" ? e.reason : null;
  } else if (e.kind === "edit") {
    type = "edit";
    verb = e.reason ? e.reason.charAt(0).toLowerCase() + e.reason.slice(1) : "edited";
    if (!/^(edited|validation default|area settings|assigned|unassigned|tagged|untagged|needs your decision|cleared the decision)/.test(verb))
      verb = `edited · ${verb}`;
  }
  if (e.source === "github" && type !== "github") type = "github";
  return { id: `ev:${e.id}`, at: e.at, type, actor, verb, object, detail, undoOpId: null };
}

type SortKey = Pick<ActivityItem, "at" | "id" | "seq">;

/**
 * Feed order: newest first; equal timestamps → higher insertion seq first (rows without one count
 * as -1), then id. Lexicographic on (at, seq, id), so it is a total order the cursor can follow.
 */
export function compareActivity(a: SortKey, b: SortKey): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  const sa = a.seq ?? -1;
  const sb = b.seq ?? -1;
  if (sa !== sb) return sb - sa;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Newest first (see compareActivity; stable for the cursor). */
export function sortActivity(items: ActivityItem[]): ActivityItem[] {
  return [...items].sort(compareActivity);
}

export function encodeCursor(item: SortKey): string {
  const key = item.seq === undefined ? [item.at, item.id] : [item.at, item.id, item.seq];
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): { at: string; id: string; seq?: number } | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string" && !Number.isNaN(Date.parse(v[0]))) {
      return typeof v[2] === "number" && Number.isInteger(v[2]) ? { at: v[0], id: v[1], seq: v[2] } : { at: v[0], id: v[1] };
    }
  } catch {
    /* bad cursor → first page */
  }
  return null;
}

/** Strictly after the cursor in feed order (compareActivity). */
export function isBefore(item: SortKey, c: SortKey) {
  return compareActivity(item, c) > 0;
}

export type ActivityFilter = { types?: ActivityType[]; actor?: ActorKind | null; q?: string | null };

export function matchesFilter(item: ActivityItem, f: ActivityFilter) {
  if (f.types?.length && !f.types.includes(item.type)) return false;
  if (f.actor && item.actor.kind !== f.actor) return false;
  const q = f.q?.trim().toLowerCase();
  if (q) {
    const hay = `${item.actor.name} ${item.verb} ${item.object?.title ?? ""} ${item.detail ?? ""}`.toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** Sort, filter, page: returns `limit` rows older than the cursor and the next cursor. */
export function pageActivity(all: ActivityItem[], f: ActivityFilter & { cursor?: string | null; limit?: number }): ActivityResponse {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const sorted = sortActivity(all).filter((i) => matchesFilter(i, f));
  const c = decodeCursor(f.cursor);
  const rest = c ? sorted.filter((i) => isBefore(i, c)) : sorted;
  const page = rest.slice(0, limit);
  const nextCursor = rest.length > limit ? encodeCursor(page[page.length - 1]) : null;
  const items = page.map(({ seq: _seq, ...item }) => item);
  return { items, nextCursor, latestAt: sorted[0]?.at ?? null };
}

export type DayGroup = { day: string; label: string; items: ActivityItem[] };

/** Group (already sorted) rows by calendar day in `timeZone`: "Today", "Yesterday", else "Mon, Oct 26". */
export function groupByDay(items: ActivityItem[], timeZone: string, now: Date = new Date()): DayGroup[] {
  const today = localDate(now, timeZone);
  const yesterday = localDate(new Date(now.getTime() - 86_400_000), timeZone);
  const groups: DayGroup[] = [];
  for (const it of items) {
    const day = localDate(new Date(it.at), timeZone);
    let g = groups[groups.length - 1];
    if (!g || g.day !== day) {
      const lbl =
        day === today
          ? "Today"
          : day === yesterday
            ? "Yesterday"
            : new Date(it.at).toLocaleDateString("en-US", {
                timeZone,
                weekday: "short",
                month: "short",
                day: "numeric",
                ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
              });
      g = { day, label: lbl, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups;
}
