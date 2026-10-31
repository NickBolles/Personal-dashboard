/**
 * "Add context" sheet helpers (pure). Finance is never sent to AI: anything that
 * points at Finance data is refused before it can become a context chip.
 */
import type { AnyRefType, RefOption, Reference } from "@/lib/references";

export type ContextPick = Reference & { detail?: string };

const FINANCE_RE = /(^|[\s/:._-])(finance|monarch)([\s/:._-]|$)/i;

/** True when a reference/URL/label points at Finance (accounts, transactions, Monarch). */
export function isFinanceContext(r: { type?: AnyRefType | string; id?: string; label?: string; url?: string }): boolean {
  if (r.type === "finance" || r.type === "monarch") return true;
  for (const v of [r.id, r.url]) {
    if (!v) continue;
    if (FINANCE_RE.test(v)) return true;
    try {
      const u = new URL(v, "https://jarvis.local");
      if (/^\/(finance|api\/finance)(\/|$)/.test(u.pathname)) return true;
    } catch {
      /* not a URL */
    }
  }
  return false;
}

/** Add a pick (deduped by type:id); finance is refused. Returns the new list and whether it was blocked. */
export function addPick(list: ContextPick[], pick: ContextPick): { list: ContextPick[]; blocked: boolean } {
  if (isFinanceContext(pick)) return { list, blocked: true };
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
      if (seen.has(key) || isFinanceContext(o)) continue;
      seen.add(key);
      rows.push({ ...o, section: s.label, key });
    }
  if (!areaTitle) return rows;
  const a = areaTitle.toLowerCase();
  const hit = (r: SheetRow) => r.label.toLowerCase() === a || (r.detail ?? "").toLowerCase().includes(a);
  const top = rows.filter(hit).map((r) => ({ ...r, section: "Suggested" }));
  return [...top, ...rows.filter((r) => !hit(r))];
}
