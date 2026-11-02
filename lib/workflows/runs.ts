/**
 * Workflow runs (spec §2.3–2.4, §12.4, §12.7; W2). Pure helpers shared by the
 * server and the Run panel: start-form defaults, on-device place matching,
 * the constrained `jarvis-capture@1` proposal protocol and its undo log.
 * No I/O here.
 */
import { capturePaths, formFields, type WorkflowDefinition, type WorkflowField } from "./definition";
import { parseScriptureRef } from "./scripture";
import { resolveSmartDate, type SmartDateSource } from "./smart-dates";
import type { ArgValue } from "./palette-args";

export const CAPTURE_FORMAT = "jarvis-capture@1";
export const MAX_CAPTURE_BYTES = 256 * 1024;
export const MAX_OPS_PER_TURN = 40;
/** D11: remembered values on by default for these field types (free text stays opt-in). */
export const REMEMBER_BY_DEFAULT = new Set(["person", "place", "select", "chips"]);

export type Capture = Record<string, unknown>;
export type Provenance = "palette" | "last" | "default" | "smart" | "workflowPlace" | "none";
export type FormValue = { value: unknown; provenance: Provenance; note?: string };

export function remembers(f: WorkflowField): boolean {
  return f.rememberLast ?? REMEMBER_BY_DEFAULT.has(f.type);
}

/* ---------------- start-form defaults (§12.4, D7, D11, D12) ---------------- */

export type DefaultsContext = {
  now: Date;
  timezone: string;
  /** most-recent-first remembered values per field id */
  remembered?: Record<string, unknown[]>;
  /** palette args (mapPaletteArgs values) */
  prefill?: Record<string, ArgValue>;
};

const QUICK_SOURCE: Record<string, SmartDateSource> = {
  today: "$today",
  now: "$now",
  tomorrow: "$tomorrow",
  nextSunday: "$nextSunday",
  serviceTime: "$serviceTime",
};

function smartValue(f: WorkflowField, source: SmartDateSource, def: WorkflowDefinition, ctx: DefaultsContext): string {
  const v = resolveSmartDate(source, { now: ctx.now, timezone: ctx.timezone, serviceTimes: def.serviceTimes });
  if (f.type === "date") return v.date;
  if (f.type === "time") return v.time ?? "";
  return v.datetime ?? `${v.date}T${v.time ?? "09:00"}`;
}

/** Palette args arrive as a date string for datetime fields: keep the service time if it falls on that day. */
function paletteValue(f: WorkflowField, raw: ArgValue, def: WorkflowDefinition): unknown {
  if (f.type === "datetime" && typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const slot = (def.serviceTimes ?? ["09:00", "10:45"])[0];
    return `${raw}T${slot}`;
  }
  if (f.type === "person" && typeof raw === "string") return { name: raw };
  return raw;
}

/**
 * Resolve every start-form field's initial value. Order: palette arg → `last`
 * (remembered) → literal / smart / workflow place → empty. Each value carries
 * its provenance so the UI can say where it came from (§12.4).
 */
export function resolveFormDefaults(def: WorkflowDefinition, slot: "start" | "mid" | "end", ctx: DefaultsContext): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const f of formFields(def, slot)) {
    const pre = ctx.prefill?.[f.id];
    if (pre !== undefined) {
      out[f.id] = { value: paletteValue(f, pre, def), provenance: "palette", note: `From /${def.slug}` };
      continue;
    }
    const d = f.default;
    const last = ctx.remembered?.[f.id]?.[0];
    if (d && "source" in d && d.source === "last") {
      if (last !== undefined) out[f.id] = { value: last, provenance: "last", note: "Last used" };
      else out[f.id] = { value: emptyValue(f), provenance: "none" };
      continue;
    }
    if (d && "value" in d && !("source" in d)) {
      out[f.id] = { value: d.value, provenance: "default", note: "Default for this workflow" };
      continue;
    }
    if (d && "source" in d && d.source === "workflowPlace") {
      const label = d.value ?? def.defaultPlace;
      out[f.id] = label
        ? { value: { label, kind: "saved" }, provenance: "workflowPlace", note: "Default for this workflow" }
        : { value: emptyValue(f), provenance: "none" };
      continue;
    }
    if (d && "source" in d) {
      const src = (d.source.startsWith("$") ? d.source : QUICK_SOURCE[d.source]) as SmartDateSource | undefined;
      if (src) {
        out[f.id] = { value: smartValue(f, src, def, ctx), provenance: "smart", note: smartNote(src) };
        continue;
      }
    }
    if (last !== undefined && remembers(f) && f.type !== "longtext" && f.type !== "text") {
      out[f.id] = { value: last, provenance: "last", note: "Last used" };
      continue;
    }
    out[f.id] = { value: emptyValue(f), provenance: "none" };
  }
  return out;
}

function smartNote(s: SmartDateSource) {
  return { $today: "Today", $now: "Now", $tomorrow: "Tomorrow", $nextSunday: "Next Sunday", $serviceTime: "Service time" }[s];
}

export function emptyValue(f: WorkflowField): unknown {
  if (f.type === "tags" || f.multiple) return [];
  if (f.type === "toggle") return false;
  if (f.type === "number") return null;
  if (f.type === "place" || f.type === "person" || f.type === "scripture") return null;
  return "";
}

/** Quick date chips for a DateTimeField (D12 service times). */
export function quickDates(def: WorkflowDefinition, f: WorkflowField, ctx: { now: Date; timezone: string }) {
  return (f.quick ?? []).map((q) => {
    const src = QUICK_SOURCE[q];
    return { id: q, label: smartNote(src), value: smartValue(f, src, def, { ...ctx }) };
  });
}

/* ---------------- form validation (§12.5) ---------------- */

export type FieldError = { field: string; message: string };

function isEmpty(v: unknown) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

export function validateForm(def: WorkflowDefinition, slot: "start" | "mid" | "end", values: Record<string, unknown>): FieldError[] {
  const errs: FieldError[] = [];
  for (const f of formFields(def, slot)) {
    const v = values[f.id];
    if (isEmpty(v)) {
      if (f.required) errs.push({ field: f.id, message: `Add ${f.label.toLowerCase()}` });
      continue;
    }
    if (f.type === "scripture") {
      const ok = typeof v === "string" ? parseScriptureRef(v).ok : typeof v === "object" && v !== null && "book" in v;
      if (!ok && f.mustParse !== false) errs.push({ field: f.id, message: "That isn't a Bible reference" });
    }
    if ((f.type === "text" || f.type === "longtext") && typeof v === "string") {
      const max = f.maxLength ?? (f.type === "text" ? 200 : 4000);
      if (v.length > max) errs.push({ field: f.id, message: `Keep it under ${max} characters` });
      if (f.minLength && v.length < f.minLength) errs.push({ field: f.id, message: `At least ${f.minLength} characters` });
    }
    if (f.type === "number" && typeof v === "number") {
      if (f.min !== undefined && v < f.min) errs.push({ field: f.id, message: `At least ${f.min}` });
      if (f.max !== undefined && v > f.max) errs.push({ field: f.id, message: `At most ${f.max}` });
    }
    if (f.type === "tags" && Array.isArray(v) && v.length > (f.max ?? 8)) errs.push({ field: f.id, message: `At most ${f.max ?? 8} tags` });
  }
  return errs;
}

/** Normalise submitted form values into capture values (scripture text → ref, person text → {name}). */
export function normaliseFieldValue(f: WorkflowField, v: unknown): unknown {
  if (f.type === "scripture" && typeof v === "string") {
    const r = parseScriptureRef(v);
    return r.ok ? r.ref : v;
  }
  if (f.type === "person" && typeof v === "string") return v.trim() ? { name: v.trim() } : null;
  if (f.type === "place" && typeof v === "string") return v.trim() ? { label: v.trim(), kind: "typed" } : null;
  return v;
}

/** Turn a submitted form into capture ops (`by:user`, `source: form:<slot>`). */
export function formToOps(def: WorkflowDefinition, slot: "start" | "mid" | "end", values: Record<string, unknown>): CaptureOp[] {
  const ops: CaptureOp[] = [];
  for (const f of formFields(def, slot)) {
    const v = normaliseFieldValue(f, values[f.id]);
    if (isEmpty(v)) continue;
    const path = f.bind.endsWith("/-") ? `/${f.bind}` : `/${f.bind.replace(".", "/")}`;
    if (f.bind.endsWith("/-")) {
      const list = f.bind.slice(0, -2);
      const of = def.capture[list]?.type === "list" ? (def.capture[list] as { of: unknown }).of : null;
      // list of objects whose first field takes the value (scripture → {ref})
      const value = of && typeof of === "object" ? { [Object.keys(of)[0]]: v } : v;
      ops.push({ op: "add", path, value });
    } else ops.push({ op: "replace", path, value: v });
  }
  return ops;
}

/* ---------------- place matching (§12.7, D9) ---------------- */

export type SavedPlace = { id: string; label: string; lat: number | null; lng: number | null; radiusM: number };

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Match a device position against SAVED places only (on-device; the position
 * never leaves the browser). Nearest place within its own radius wins.
 */
export function matchSavedPlace(pos: { lat: number; lng: number }, places: SavedPlace[]): { place: SavedPlace; distanceM: number } | null {
  let best: { place: SavedPlace; distanceM: number } | null = null;
  for (const p of places) {
    if (p.lat === null || p.lng === null || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const d = haversineM(pos, { lat: p.lat, lng: p.lng });
    if (d <= (p.radiusM || 300) && (!best || d < best.distanceM)) best = { place: p, distanceM: d };
  }
  return best;
}

export function formatDistance(m: number): string {
  const mi = m / 1609.344;
  return mi < 0.1 ? "under 0.1 mi" : `${mi.toFixed(1)} mi`;
}

/* ---------------- capture ops (jarvis-capture@1, §2.4, D2) ---------------- */

export type CaptureOp = { op: "add" | "replace" | "remove"; path: string; value?: unknown };
export type LogEntry = { id: string; at: string; by: "user" | "agent"; source?: string; op: CaptureOp; inverse: CaptureOp; undone?: boolean };
export type DroppedOp = { op: unknown; reason: string };

/** Initial capture: empty lists, empty objects. */
export function emptyCapture(def: WorkflowDefinition): Capture {
  const c: Capture = {};
  for (const [k, v] of Object.entries(def.capture)) c[k] = v.type === "list" ? [] : {};
  return c;
}

const SEG = /^[a-z][A-Za-z0-9_]{0,39}$/;

type Target = { kind: "objField"; key: string; field: string } | { kind: "listAppend"; key: string } | { kind: "listIndex"; key: string; index: number };

function parsePath(def: WorkflowDefinition, path: string): Target | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const parts = path.slice(1).split("/");
  if (parts.length !== 2 || !SEG.test(parts[0])) return null;
  const entry = def.capture[parts[0]];
  if (!entry) return null;
  if (entry.type === "object") return SEG.test(parts[1]) && parts[1] in entry.fields ? { kind: "objField", key: parts[0], field: parts[1] } : null;
  if (parts[1] === "-") return { kind: "listAppend", key: parts[0] };
  if (/^\d{1,4}$/.test(parts[1])) return { kind: "listIndex", key: parts[0], index: Number(parts[1]) };
  return null;
}

function scalarOk(spec: string, v: unknown): boolean {
  const optional = spec.endsWith("?");
  const base = spec.replace(/\?$/, "");
  if (v === null || v === undefined) return optional;
  if (base.startsWith("list<")) return Array.isArray(v) && v.length <= 50 && v.every((x) => scalarOk(base.slice(5, -1), x));
  switch (base) {
    case "text":
      return typeof v === "string" && v.length <= 2000;
    case "longtext":
      return typeof v === "string" && v.length <= 4000;
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    case "datetime":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v);
    case "time":
      return typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "bool":
      return typeof v === "boolean";
    case "tags":
      return Array.isArray(v) && v.length <= 8 && v.every((t) => typeof t === "string" && t.length <= 40);
    case "scripture_ref":
      return (typeof v === "object" && !!v && typeof (v as { display?: unknown }).display === "string") || (typeof v === "string" && parseScriptureRef(v).ok);
    case "place":
      return (typeof v === "object" && !!v && typeof (v as { label?: unknown }).label === "string" && !("lat" in v) && !("lng" in v)) || typeof v === "string";
    case "person":
      return (typeof v === "object" && !!v && typeof (v as { name?: unknown }).name === "string") || typeof v === "string";
  }
  return false;
}

/** Coerce agent shorthand (strings for refs/places/people) into stored shapes. */
function coerceScalar(spec: string, v: unknown): unknown {
  const base = spec.replace(/\?$/, "");
  if (typeof v !== "string") return v;
  if (base === "scripture_ref") {
    const r = parseScriptureRef(v);
    return r.ok ? r.ref : v;
  }
  if (base === "place") return { label: v.slice(0, 80), kind: "typed" };
  if (base === "person") return { name: v.slice(0, 80) };
  return v;
}

function itemOk(of: string | Record<string, string>, v: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (typeof of === "string") {
    const c = coerceScalar(of, v);
    return scalarOk(of, c) ? { ok: true, value: c } : { ok: false, reason: "wrong_type" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, reason: "wrong_type" };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!(k in of)) return { ok: false, reason: "unknown_field" };
  for (const [k, spec] of Object.entries(of)) {
    const c = coerceScalar(spec, (v as Record<string, unknown>)[k]);
    if (!scalarOk(spec, c)) return { ok: false, reason: c === undefined ? "missing_field" : "wrong_type" };
    if (c !== undefined) out[k] = c;
  }
  return { ok: true, value: out };
}

/**
 * Validate ops against the pinned schema and current capture. Only declared
 * capture paths, only add/replace/remove, typed values, size-capped. Invalid
 * ops are dropped with a reason (the UI shows "1 note not filed").
 */
export function validateOps(def: WorkflowDefinition, capture: Capture, raw: unknown): { ops: CaptureOp[]; dropped: DroppedOp[] } {
  const ops: CaptureOp[] = [];
  const dropped: DroppedOp[] = [];
  const list = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) dropped.push({ op: raw, reason: "not_a_list" });
  // lengths as ops would leave them, so later indexes in the same batch are checked correctly
  const lens = new Map<string, number>();
  const len = (k: string) => lens.get(k) ?? (Array.isArray(capture[k]) ? (capture[k] as unknown[]).length : 0);
  for (const [i, o] of list.entries()) {
    if (i >= MAX_OPS_PER_TURN) {
      dropped.push({ op: o, reason: "too_many_ops" });
      continue;
    }
    if (typeof o !== "object" || o === null) {
      dropped.push({ op: o, reason: "not_an_op" });
      continue;
    }
    const { op, path, value } = o as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !["op", "path", "value"].includes(k));
    if (extra.length || (op !== "add" && op !== "replace" && op !== "remove")) {
      dropped.push({ op: o, reason: "bad_op" });
      continue;
    }
    const t = parsePath(def, path as string);
    if (!t) {
      dropped.push({ op: o, reason: "undeclared_path" });
      continue;
    }
    if (t.kind === "objField") {
      if (op === "add") {
        dropped.push({ op: o, reason: "bad_op" });
        continue;
      }
      const spec = (def.capture[t.key] as { fields: Record<string, string> }).fields[t.field];
      if (op === "remove") {
        ops.push({ op: "remove", path: path as string });
        continue;
      }
      const c = coerceScalar(spec, value);
      if (!scalarOk(spec, c) || c === null) {
        dropped.push({ op: o, reason: "wrong_type" });
        continue;
      }
      ops.push({ op: "replace", path: path as string, value: c });
      continue;
    }
    const of = (def.capture[t.key] as { of: string | Record<string, string> }).of;
    const n = len(t.key);
    if (t.kind === "listAppend") {
      if (op !== "add") {
        dropped.push({ op: o, reason: "bad_op" });
        continue;
      }
      if (n >= 500) {
        dropped.push({ op: o, reason: "list_full" });
        continue;
      }
    } else if (op === "add" ? t.index > n : t.index >= n) {
      dropped.push({ op: o, reason: "out_of_range" });
      continue;
    }
    if (op === "remove") {
      ops.push({ op: "remove", path: path as string });
      lens.set(t.key, n - 1);
      continue;
    }
    const r = itemOk(of, value);
    if (!r.ok) {
      dropped.push({ op: o, reason: r.reason });
      continue;
    }
    ops.push({ op: op as "add" | "replace", path: path as string, value: r.value });
    if (op === "add") lens.set(t.key, n + 1);
  }
  return { ops, dropped };
}

/** Apply one validated op; returns the new capture and the op that undoes it. Never mutates input. */
export function applyOp(def: WorkflowDefinition, capture: Capture, op: CaptureOp): { capture: Capture; inverse: CaptureOp } {
  const t = parsePath(def, op.path);
  if (!t) throw new Error("undeclared_path");
  const next: Capture = { ...capture };
  if (t.kind === "objField") {
    const obj = { ...((capture[t.key] as Record<string, unknown>) ?? {}) };
    const had = t.field in obj;
    const prev = obj[t.field];
    if (op.op === "remove") delete obj[t.field];
    else obj[t.field] = op.value;
    next[t.key] = obj;
    return { capture: next, inverse: had ? { op: "replace", path: op.path, value: prev } : { op: "remove", path: op.path } };
  }
  const arr = [...((capture[t.key] as unknown[]) ?? [])];
  const idx = t.kind === "listAppend" ? arr.length : t.index;
  const at = `/${t.key}/${idx}`;
  let inverse: CaptureOp;
  if (op.op === "add") {
    arr.splice(idx, 0, op.value);
    inverse = { op: "remove", path: at };
  } else if (op.op === "replace") {
    inverse = { op: "replace", path: at, value: arr[idx] };
    arr[idx] = op.value;
  } else {
    inverse = { op: "add", path: at, value: arr[idx] };
    arr.splice(idx, 1);
  }
  next[t.key] = arr;
  return { capture: next, inverse };
}

export function applyOps(
  def: WorkflowDefinition,
  capture: Capture,
  ops: CaptureOp[],
  meta: { by: "user" | "agent"; source?: string; at: string; id: () => string },
) {
  let c = capture;
  const entries: LogEntry[] = [];
  for (const op of ops) {
    const r = applyOp(def, c, op);
    c = r.capture;
    entries.push({ id: meta.id(), at: meta.at, by: meta.by, ...(meta.source ? { source: meta.source } : {}), op, inverse: r.inverse });
  }
  if (JSON.stringify(c).length > MAX_CAPTURE_BYTES) throw new Error("capture_too_large");
  return { capture: c, entries };
}

/**
 * Undo log entries (each change undoable, D2). Entries undo newest-first; an
 * entry whose inverse no longer applies (e.g. list shifted) is reported, not forced.
 */
export function undoEntries(
  def: WorkflowDefinition,
  capture: Capture,
  log: LogEntry[],
  ids: string[],
): { capture: Capture; log: LogEntry[]; undone: string[]; failed: string[] } {
  const want = new Set(ids);
  let c = capture;
  const undone: string[] = [];
  const failed: string[] = [];
  const next = log.map((e) => ({ ...e }));
  for (let i = next.length - 1; i >= 0; i--) {
    const e = next[i];
    if (!want.has(e.id) || e.undone) continue;
    // entries after this one that are still live would be invalidated for list indexes: only undo in stack order
    const later = next.slice(i + 1).some((x) => !x.undone && !want.has(x.id) && sameKey(x.op.path, e.op.path) && isList(def, e.op.path));
    const v = validateOps(def, c, [e.inverse]);
    if (later || !v.ops.length) {
      failed.push(e.id);
      continue;
    }
    c = applyOp(def, c, v.ops[0]).capture;
    e.undone = true;
    undone.push(e.id);
  }
  return { capture: c, log: next, undone, failed };
}

function sameKey(a: string, b: string) {
  return a.split("/")[1] === b.split("/")[1];
}
function isList(def: WorkflowDefinition, path: string) {
  return def.capture[path.split("/")[1]]?.type === "list";
}

/** Pull every ```jarvis-capture fenced block out of an assistant turn. */
export function extractCaptureBlocks(text: string): { ops: unknown[]; propose: boolean; errors: number } {
  const ops: unknown[] = [];
  let propose = false;
  let errors = 0;
  const re = /```jarvis-capture[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re)) {
    try {
      const j = JSON.parse(m[1]) as unknown;
      if (Array.isArray(j)) ops.push(...j);
      else if (j && typeof j === "object" && Array.isArray((j as { ops?: unknown }).ops)) {
        ops.push(...(j as { ops: unknown[] }).ops);
        if ((j as { propose?: unknown }).propose === true) propose = true;
      } else errors++;
    } catch {
      errors++;
    }
  }
  return { ops, propose, errors };
}

/** Proposal for form-bound fields (§12.8): never applied without a tap; other paths apply instantly. */
export function splitProposals(def: WorkflowDefinition, ops: CaptureOp[], propose: boolean): { apply: CaptureOp[]; proposed: CaptureOp[] } {
  if (!propose) return { apply: ops, proposed: [] };
  const formPaths = new Set(
    ["start", "mid", "end"].flatMap((s) => formFields(def, s as "start").map((f) => (f.bind.endsWith("/-") ? `/${f.bind}` : `/${f.bind.replace(".", "/")}`))),
  );
  return { apply: ops.filter((o) => !formPaths.has(o.path)), proposed: ops.filter((o) => formPaths.has(o.path)) };
}

/** Run-context instructions for the agent (≤ 2 KB): declared paths only. */
export function captureInstructions(def: WorkflowDefinition): string {
  const paths = [...capturePaths(def.capture)];
  const lines = Object.entries(def.capture).map(([k, v]) =>
    v.type === "list"
      ? `/${k}/- : ${typeof v.of === "string" ? v.of : JSON.stringify(v.of)}`
      : Object.entries(v.fields)
          .map(([f, s]) => `/${k}/${f} : ${s}`)
          .join("\n"),
  );
  return [
    `Live capture (${CAPTURE_FORMAT}): after each reply, add ONE fenced block \`\`\`jarvis-capture with a JSON list of ops {"op":"add"|"replace"|"remove","path","value"} for what this message adds.`,
    "Only these paths (others are dropped):",
    ...lines,
    `Use "add" with /<list>/- to append; never invent fields; quotes verbatim. Paths known: ${paths.length}.`,
  ]
    .join("\n")
    .slice(0, 2048);
}

/** Title from the start prompt template: `{session.place}` → label/name/display. */
export function renderTemplate(tpl: string, capture: Capture): string {
  return tpl
    .replace(/\{([a-z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\}/g, (_, a: string, b: string) =>
      displayValue((capture[a] as Record<string, unknown> | undefined)?.[b]),
    )
    .replace(/\s+[–-]\s*$/, "")
    .replace(/^\s*[–-]\s+/, "")
    .trim();
}

export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(displayValue).join(", ");
  const o = v as Record<string, unknown>;
  return String(o.display ?? o.label ?? o.name ?? o.text ?? "");
}
