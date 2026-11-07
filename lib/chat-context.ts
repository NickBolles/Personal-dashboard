/**
 * "Add context" sheet helpers (pure). AI exclusions are resolved server-side
 * from ancestry, not inferred from reference names or URLs.
 */
import type { RefOption, Reference } from "@/lib/references";

export type ContextPick = Reference & { detail?: string };

/** Add a pick (deduped by type:id). Server resolution enforces AI exclusions. */
export function addPick(list: ContextPick[], pick: ContextPick): { list: ContextPick[]; blocked: boolean } {
  if (list.some((p) => p.type === pick.type && p.id === pick.id)) return { list, blocked: false };
  return { list: [...list, pick].slice(0, 20), blocked: false };
}

export function togglePick(list: ContextPick[], pick: ContextPick): { list: ContextPick[]; blocked: boolean } {
  if (list.some((p) => p.type === pick.type && p.id === pick.id))
    return { list: list.filter((p) => !(p.type === pick.type && p.id === pick.id)), blocked: false };
  return addPick(list, pick);
}

export type SheetRow = RefOption & { section: string; key: string };

/**
 * Flatten sections into one keyboard list. Rows matching the current area
 * (detail/path contains it) float to the top as "Suggested".
 */
export function flattenSections(sections: { label: string; options: RefOption[] }[], areaTitle?: string): SheetRow[] {
  const rows: SheetRow[] = [];
  const seen = new Set<string>();
  for (const s of sections)
    for (const o of s.options) {
      const key = `${o.type}:${o.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...o, section: s.label, key });
    }
  if (!areaTitle) return rows;
  const a = areaTitle.toLowerCase();
  const hit = (r: SheetRow) => r.label.toLowerCase() === a || (r.detail ?? "").toLowerCase().includes(a);
  const top = rows.filter(hit).map((r) => ({ ...r, section: "Suggested" }));
  return [...top, ...rows.filter((r) => !hit(r))];
}
