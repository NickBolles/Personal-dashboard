/**
 * Pure tree rules for drag-and-drop placement and undo (docs/work.md). The
 * store loads rows, asks these what the result should be, then writes it.
 */
export { wouldCreateCycle } from "./lifecycle";

/**
 * New sibling order after putting `id` at `index` among `siblings` (in their
 * current order; `id` may or may not already be among them). The built-in
 * Miscellaneous area always stays last. `index` is clamped.
 */
export function planPlacement(siblings: { id: string; builtIn?: boolean }[], id: string, index: number): string[] {
  const rest = siblings.filter((s) => s.id !== id && !s.builtIn);
  const pinned = siblings.filter((s) => s.id !== id && s.builtIn);
  const i = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : rest.length, rest.length));
  return [...rest.slice(0, i).map((s) => s.id), id, ...rest.slice(i).map((s) => s.id), ...pinned.map((s) => s.id)];
}

/** Ids of `id` and everything under it (used to refuse drops into one's own subtree). */
export function descendantsOf(parents: Map<string, string | null>, id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of parents)
      if (parent && out.has(parent) && !out.has(child)) {
        out.add(child);
        grew = true;
      }
  }
  return out;
}
