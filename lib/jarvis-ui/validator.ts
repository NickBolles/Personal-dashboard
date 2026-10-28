import { CATALOG_ID, COMPONENTS, CONTAINERS, LIMITS, type ComponentName, type JarvisSpec, type UIElement } from "./catalog";

export type ValidateResult =
  { ok: true; spec: JarvisSpec; dropped: number } | { ok: false; reason: "json" | "too_large" | "shape" | "catalog" | "too_many" | "root" };

const KEY = /^[A-Za-z0-9_-]{1,60}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse + validate one block against `jarvis-ui@1`. Invalid or unknown
 * elements are dropped (with their subtree); the block fails only when the
 * JSON is broken, over the limits, or nothing renderable is left. The result
 * is canonical: only reachable, validated elements in the catalog shape.
 */
export function validateBlock(raw: string): ValidateResult {
  if (raw.length > LIMITS.blockBytes) return { ok: false, reason: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "json" };
  }
  return validateSpec(parsed);
}

export function validateSpec(input: unknown): ValidateResult {
  if (!isObj(input) || typeof input.root !== "string" || !isObj(input.elements)) return { ok: false, reason: "shape" };
  if (input.catalog !== undefined && input.catalog !== CATALOG_ID) return { ok: false, reason: "catalog" };
  if (input.v !== undefined && input.v !== 1) return { ok: false, reason: "catalog" };
  const entries = Object.entries(input.elements);
  if (entries.length > LIMITS.elements) return { ok: false, reason: "too_many" };

  let dropped = 0;
  const valid = new Map<string, UIElement>();
  for (const [key, el] of entries) {
    if (!KEY.test(key) || !isObj(el) || typeof el.type !== "string" || !Object.hasOwn(COMPONENTS, el.type)) {
      dropped++;
      continue;
    }
    const type = el.type as ComponentName;
    const props = COMPONENTS[type].safeParse(el.props ?? {});
    if (!props.success) {
      dropped++;
      continue;
    }
    const children = Array.isArray(el.children) ? el.children.filter((c): c is string => typeof c === "string").slice(0, LIMITS.elements) : [];
    valid.set(key, { type, props: props.data as Record<string, unknown>, ...(CONTAINERS.has(type) ? { children } : {}) });
  }

  const elements: Record<string, UIElement> = {};
  const seen = new Set<string>();
  const walk = (key: string, depth: number): boolean => {
    const el = valid.get(key);
    if (!el || seen.has(key) || depth > LIMITS.depth) return false;
    seen.add(key);
    const kids = (el.children ?? []).filter((c) => walk(c, depth + 1));
    elements[key] = el.children ? { ...el, children: kids } : el;
    return true;
  };
  if (!walk(input.root, 1)) return { ok: false, reason: "root" };
  dropped += entries.length - dropped - seen.size;
  return { ok: true, spec: { v: 1, catalog: CATALOG_ID, root: input.root, elements }, dropped };
}

/** Deterministic JSON (sorted keys) for hashing and intent comparison. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Every ref a spec mentions (for one hydrate call). */
export function specRefs(spec: JarvisSpec): string[] {
  const refs = new Set<string>();
  for (const el of Object.values(spec.elements)) {
    const p = el.props as Record<string, unknown>;
    if (el.type === "TaskList") for (const r of p.rows as { ref: string }[]) refs.add(r.ref);
    if (el.type === "ItemRef") refs.add(p.ref as string);
    if (el.type === "Table") for (const r of p.rows as { ref?: string }[]) if (r.ref) refs.add(r.ref);
    if (el.type === "DecisionCard")
      for (const o of p.options as { intent?: { ref?: string; parentRef?: string } }[]) {
        if (o.intent?.ref) refs.add(o.intent.ref);
        if (o.intent?.parentRef) refs.add(o.intent.parentRef);
      }
    if (el.type === "TaskList" && p.promoteParentRef) refs.add(p.promoteParentRef as string);
    if (el.type === "ApprovalChips") for (const r of p.rows as { ref: string }[]) refs.add(r.ref);
    if (el.type === "WeekPlan") {
      for (const b of p.blocks as { ref: string }[]) refs.add(b.ref);
      refs.add(calendarRef(p.weekOf as string, (p.days as 5 | 7 | undefined) ?? 5));
    }
    if (el.type === "PRCard") refs.add(p.ref as string);
    if ((el.type === "Gauge" || el.type === "Sparkline") && typeof p.metric === "string") refs.add(p.metric);
  }
  return [...refs];
}

/** The hydration ref for a week plan's fixed calendar events (synthesized by Jarvis; never written by the model). */
export function calendarRef(weekOf: string, days: 5 | 7) {
  return `cal:week:${weekOf}:${days}`;
}
