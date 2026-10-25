/**
 * Undo rules for structural operations (docs/work.md). Pure: the store loads
 * the operation and the item's latest operation and asks these.
 */

/** The toast offers Undo for ~10 s; the server accepts it a little longer (slow networks, retries). */
export const UNDO_WINDOW_MS = 10 * 60_000;

export const UNDO_KINDS = ["move", "reorder", "archive", "unarchive", "split", "fork", "settle", "ai_plan_create"] as const;
export type UndoKind = (typeof UNDO_KINDS)[number];

export const UNDO_LABELS: Record<UndoKind, string> = {
  move: "Moved",
  reorder: "Reordered",
  archive: "Archived",
  unarchive: "Unarchived",
  split: "Split into a child",
  fork: "Forked",
  /** an area's auto_after_quiet policy settled it (undo reopens it to its previous status) */
  settle: "Settled automatically",
  /** "Create N child items" from an AI plan report (undo deletes untouched children, archives the rest) */
  ai_plan_create: "Created plan children",
};

export type OpLike = { id: string; createdAt: string; undoneAt: string | null };

export type UndoCheck = { ok: true } | { ok: false; code: "already_undone" | "superseded" | "expired"; message: string };

/**
 * An operation can be undone once, only while it is still the latest
 * structural operation on its item, and only within the window.
 */
export function undoCheck(op: OpLike, latestOpId: string | null, now: Date, windowMs = UNDO_WINDOW_MS): UndoCheck {
  if (op.undoneAt) return { ok: false, code: "already_undone", message: "Already undone" };
  if (latestOpId !== op.id) return { ok: false, code: "superseded", message: "Something else changed this item since, so undo isn't safe" };
  if (now.getTime() - new Date(op.createdAt).getTime() > windowMs) return { ok: false, code: "expired", message: "Too late to undo" };
  return { ok: true };
}

/** Latest operation first: newest createdAt, then id (ids are random, so this only breaks exact ties deterministically). */
export function latestOp<T extends OpLike>(ops: T[]): T | null {
  return [...ops].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
}

/**
 * Undoing a split/fork deletes the new item only if nobody touched it since it
 * was created: no edits, no events beyond its creation, no children, packets,
 * validations, dependencies, or links beyond the ones copied at creation.
 * Otherwise the item is archived instead (nothing is lost).
 */
export function isUntouched(x: {
  createdAt: string;
  updatedAt: string;
  eventKinds: string[];
  children: number;
  packets: number;
  validations: number;
  links: number;
  copiedLinks: number;
  dependencies?: number;
  /** lineage edges that point at it (something was forked/split from it) */
  derived?: number;
}) {
  return (
    x.updatedAt === x.createdAt &&
    x.eventKinds.every((k) => k === "created") &&
    x.children === 0 &&
    x.packets === 0 &&
    x.validations === 0 &&
    (x.dependencies ?? 0) === 0 &&
    (x.derived ?? 0) === 0 &&
    x.links === x.copiedLinks
  );
}
