/**
 * Version history helpers (W3): a readable diff between two immutable
 * definition versions and the restore rule (restore = save the old
 * definition as a NEW version; history is never rewritten).
 */
import type { WorkflowDefinition } from "./definition";

export type DiffChange = { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Keyed arrays (form fields by id, triggers by kind) diff per item, others as a whole. */
function keyOf(v: unknown): string | null {
  if (!isObj(v)) return typeof v === "string" ? `ref:${v}` : null;
  if (typeof v.id === "string") return v.id;
  if (typeof v.kind === "string") return `${v.kind}${typeof v.command === "string" ? v.command : ""}`;
  if (typeof v.label === "string") return v.label;
  return null;
}

function walk(a: unknown, b: unknown, path: string, out: DiffChange[]) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a === undefined) return void out.push({ path, kind: "added", after: b });
  if (b === undefined) return void out.push({ path, kind: "removed", before: a });
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ka = a.map(keyOf);
    const kb = b.map(keyOf);
    if (ka.every((k) => k) && kb.every((k) => k) && new Set(ka).size === ka.length && new Set(kb).size === kb.length) {
      const ma = new Map(a.map((v, i) => [ka[i]!, v]));
      const mb = new Map(b.map((v, i) => [kb[i]!, v]));
      for (const k of new Set([...ka, ...kb] as string[])) walk(ma.get(k), mb.get(k), `${path}[${k}]`, out);
      const order = (xs: (string | null)[], other: Map<string, unknown>) => xs.filter((k) => other.has(k!)).join(",");
      if (order(ka, mb) !== order(kb, ma)) out.push({ path, kind: "changed", before: ka, after: kb });
      return;
    }
  }
  out.push({ path, kind: "changed", before: a, after: b });
}

export function diffDefinitions(from: WorkflowDefinition | null, to: WorkflowDefinition | null): DiffChange[] {
  const out: DiffChange[] = [];
  walk(from ?? undefined, to ?? undefined, "", out);
  return out;
}

/** One-line summary for the history list ("3 changes: instructions, forms.start…"). */
export function summarizeDiff(changes: DiffChange[]): string {
  if (!changes.length) return "No changes";
  const heads = [...new Set(changes.map((c) => c.path.split(/[.[]/)[0] || "definition"))];
  return `${changes.length} change${changes.length === 1 ? "" : "s"}: ${heads.slice(0, 4).join(", ")}${heads.length > 4 ? "…" : ""}`;
}

/** Restore: the old definition with the CURRENT slug (slug is the /command and is locked). */
export function restoreDefinition(old: WorkflowDefinition, current: WorkflowDefinition): WorkflowDefinition {
  const out: WorkflowDefinition = { ...old, slug: current.slug };
  if (out.triggers) out.triggers = out.triggers.map((t) => (t.kind === "palette" ? { ...t, command: `/${current.slug}` } : t));
  return out;
}

export function restoreNote(version: number) {
  return `Restored v${version}`;
}
