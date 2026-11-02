import { z } from "zod";
import { validateSpec } from "@/lib/jarvis-ui/validator";

/**
 * `jarvis-workflow@1` definition (spec §2.2 + §12.2–12.5): the stored and
 * import/export format. No code, no HTML, no URLs; layout = catalog-only
 * json-render spec validated by lib/jarvis-ui/validator.
 */

export const WORKFLOW_FORMAT = "jarvis-workflow@1";
export const MAX_DEFINITION_BYTES = 32 * 1024;

export const WORKFLOW_ICONS = [
  "book-open",
  "notebook",
  "list-checks",
  "calendar",
  "sparkles",
  "message-circle",
  "clipboard",
  "lightbulb",
  "heart",
  "hammer",
  "bug",
  "music",
  "users",
  "home",
  "flag",
] as const;
export const MODEL_TIERS = ["fast", "standard", "deep"] as const;
export const FIELD_TYPES = [
  "text",
  "longtext",
  "select",
  "chips",
  "date",
  "time",
  "datetime",
  "place",
  "person",
  "scripture",
  "tags",
  "number",
  "toggle",
] as const;
/** the 10 field families of §12.3 (select/chips and date/time/datetime share a family) */
export type FieldType = (typeof FIELD_TYPES)[number];
export const CAPTURE_SCALARS = ["text", "longtext", "date", "datetime", "time", "number", "bool", "scripture_ref", "place", "person", "tags"] as const;
export const SMART_SOURCES = ["$today", "$now", "$tomorrow", "$nextSunday", "$serviceTime"] as const;
export const PATTERNS = ["email", "slug", "hhmm"] as const;

const NO_HTML = /<[a-z!/]|javascript:|https?:\/\//i;
const safe = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !NO_HTML.test(s), "no HTML or URLs");
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "lowercase letters, digits and dashes");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** capture field spec: "text" | "text?" | "list<text>?" */
const scalarSpec = z.string().regex(new RegExp(`^(list<)?(${CAPTURE_SCALARS.join("|")})>?\\??$`), "unknown capture type");
const objFields = z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), scalarSpec);
const captureEntry = z.union([
  z.object({ type: z.literal("object"), fields: objFields }).strict(),
  z.object({ type: z.literal("list"), of: z.union([scalarSpec, objFields]) }).strict(),
]);

const defaultSchema = z.union([
  z.object({ value: z.union([safe(200), z.number(), z.boolean()]) }).strict(),
  z.object({ source: z.literal("last") }).strict(),
  z.object({ source: z.literal("workflowPlace"), value: safe(80).optional() }).strict(),
  z.object({ source: z.enum(SMART_SOURCES), fallback: z.enum(SMART_SOURCES).optional() }).strict(),
  z.object({ source: z.enum(["today", "now", "tomorrow", "nextSunday", "serviceTime"]), fallback: z.enum(SMART_SOURCES).optional() }).strict(),
]);

const optionsSchema = z.union([
  z.object({ source: z.literal("static"), items: z.array(z.object({ value: safe(80), label: safe(80) }).strict()).max(50) }).strict(),
  z.object({ source: z.enum(["recentValues", "people", "places"]), limit: z.number().int().min(1).max(20).optional() }).strict(),
]);

export const fieldSchema = z
  .object({
    id: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/),
    bind: z.string().regex(/^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*|\/-)?$/, "capture path like session.speaker or quotes/-"),
    type: z.enum(FIELD_TYPES),
    label: safe(80).pipe(z.string().min(1)),
    help: safe(200).optional(),
    placeholder: safe(80).optional(),
    required: z.boolean().optional(),
    rememberLast: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    default: defaultSchema.optional(),
    suggest: z
      .array(z.enum(["last", "recentValues", "recentRuns", "people", "saved", "recent"]))
      .max(4)
      .optional(),
    options: optionsSchema.optional(),
    allowNew: z.boolean().optional(),
    multiple: z.boolean().optional(),
    geolocate: z.enum(["off", "matchSaved"]).optional(),
    allowRange: z.boolean().optional(),
    mustParse: z.boolean().optional(),
    max: z.number().int().min(1).max(8).optional(),
    min: z.number().optional(),
    step: z.number().positive().optional(),
    unit: safe(12).optional(),
    minLength: z.number().int().min(0).max(4000).optional(),
    maxLength: z.number().int().min(1).max(4000).optional(),
    pattern: z.enum(PATTERNS).optional(),
    dateRange: z
      .object({ notFuture: z.boolean().optional(), withinDays: z.number().int().min(1).max(365).optional() })
      .strict()
      .optional(),
    quick: z
      .array(z.enum(["today", "nextSunday", "serviceTime", "tomorrow"]))
      .max(4)
      .optional(),
  })
  .strict();
export type WorkflowField = z.infer<typeof fieldSchema>;

const formSchema = z
  .object({
    title: safe(80).optional(),
    submit: safe(40).optional(),
    /** full fields, or ids of fields declared in another form (mid/end reuse start fields) */
    fields: z
      .array(z.union([fieldSchema, z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/)]))
      .min(1)
      .max(20),
    skipWhenComplete: z.boolean().optional(),
  })
  .strict();

const exportSchema = z.union([
  z.object({ kind: z.literal("markdown"), template: safe(80).optional() }).strict(),
  z.object({ kind: z.literal("drive"), folder: safe(120) }).strict(),
  z.object({ kind: z.literal("items"), from: z.string().max(40), parent: safe(120) }).strict(),
]);

const triggerSchema = z.union([
  z.object({ kind: z.literal("palette"), command: z.string().regex(/^\/[a-z][a-z0-9-]{1,39}$/) }).strict(),
  z.object({ kind: z.literal("share") }).strict(),
  z.object({ kind: z.literal("schedule"), cron: z.string().regex(/^[\d*,/-]+( [\d*,/-]+){4}$/), action: z.enum(["remind", "start"]) }).strict(),
  z.object({ kind: z.literal("areaPage") }).strict(),
]);

export const definitionSchema = z
  .object({
    format: z.literal(WORKFLOW_FORMAT),
    name: safe(60).pipe(z.string().min(1)),
    slug,
    icon: z.enum(WORKFLOW_ICONS),
    hue: z
      .string()
      .regex(/^[a-z]{2,16}$/)
      .optional(),
    description: safe(280).optional(),
    routing: z
      .object({
        area: safe(120).nullable(),
        agentProfile: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
          .nullable()
          .optional(),
        modelTier: z.enum(MODEL_TIERS),
      })
      .strict(),
    instructions: z.string().min(1).max(4000),
    serviceTimes: z.array(hhmm).max(6).optional(),
    defaultPlace: safe(80).optional(),
    capture: z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), captureEntry),
    start: z
      .object({ prompt: safe(160).optional(), args: z.array(z.string()).max(6).optional() })
      .strict()
      .optional(),
    forms: z.object({ start: formSchema.optional(), mid: formSchema.optional(), end: formSchema.optional() }).strict().optional(),
    quickAdd: z
      .array(z.object({ label: safe(24), field: z.string().max(40), prefix: safe(8).optional() }).strict())
      .max(8)
      .optional(),
    layout: z.unknown().optional(),
    outputs: z
      .object({
        item: z.enum(["none", "perRun", "single"]).optional(),
        summary: z
          .object({ instructions: z.string().max(2000), layout: z.unknown().optional() })
          .strict()
          .optional(),
        exports: z.array(exportSchema).max(4).optional(),
      })
      .strict()
      .optional(),
    triggers: z.array(triggerSchema).max(8).optional(),
    reflectionPrompts: z.enum(["off", "onRequest", "afterPoints"]).optional(),
    policy: z
      .object({ settle: z.literal("manual"), aiContext: z.literal("workflow_only") })
      .strict()
      .optional(),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

export type DefinitionIssue = { path: string; code: string; message: string };
export type DefinitionResult = { ok: true; definition: WorkflowDefinition } | { ok: false; issues: DefinitionIssue[] };

/** Declared capture paths: "session.speaker", "quotes" (lists accept "quotes/-"). */
export function capturePaths(capture: WorkflowDefinition["capture"]): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(capture)) {
    out.add(k);
    if (v.type === "object") for (const f of Object.keys(v.fields)) out.add(`${k}.${f}`);
  }
  return out;
}

function bindOk(bind: string, def: WorkflowDefinition, paths: Set<string>) {
  if (bind.endsWith("/-")) {
    const k = bind.slice(0, -2);
    return def.capture[k]?.type === "list";
  }
  return paths.has(bind) && def.capture[bind]?.type !== "object";
}

const FINANCE = /^\s*finance(\s*\/|$)/i;

/**
 * Full validation: zod shape + size + cross-field rules (bind_unknown_path,
 * duplicate field ids, unknown field refs, args, quickAdd targets, layout via
 * the jarvis-ui catalog, finance_excluded).
 */
export function validateDefinition(input: unknown, opts: { excludedAreas?: string[] } = {}): DefinitionResult {
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(input) ?? "").length;
  } catch {
    return { ok: false, issues: [{ path: "", code: "not_json", message: "Not valid JSON" }] };
  }
  if (size > MAX_DEFINITION_BYTES) return { ok: false, issues: [{ path: "", code: "too_large", message: "Definition is over 32 KB" }] };
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), code: "invalid", message: i.message })) };
  const def = parsed.data;
  const issues: DefinitionIssue[] = [];
  const paths = capturePaths(def.capture);
  if (Object.keys(def.capture).length > 40 || paths.size > 80) issues.push({ path: "capture", code: "too_many_fields", message: "At most 40 capture fields" });

  const area = def.routing.area;
  if (area && (FINANCE.test(area) || (opts.excludedAreas ?? []).some((x) => x.toLowerCase() === area.toLowerCase()))) {
    issues.push({ path: "routing.area", code: "finance_excluded", message: "Workflows can't use Finance or AI-excluded areas" });
  }

  const fieldIds = new Map<string, WorkflowField>();
  const forms = def.forms ?? {};
  const slots = ["start", "mid", "end"] as const;
  for (const slot of slots) {
    for (const [i, f] of (forms[slot]?.fields ?? []).entries()) {
      if (typeof f === "string") continue;
      const p = `forms.${slot}.fields.${i}`;
      if (fieldIds.has(f.id)) issues.push({ path: `${p}.id`, code: "duplicate_field", message: `Field id "${f.id}" is used twice` });
      fieldIds.set(f.id, f);
      if (!bindOk(f.bind, def, paths)) issues.push({ path: `${p}.bind`, code: "bind_unknown_path", message: `"${f.bind}" isn't a capture field` });
      if (f.minLength != null && f.maxLength != null && f.minLength > f.maxLength)
        issues.push({ path: p, code: "bad_length", message: "minLength is above maxLength" });
      const cap = f.type === "longtext" ? 4000 : 200;
      if (f.maxLength != null && f.maxLength > cap)
        issues.push({ path: `${p}.maxLength`, code: "too_long", message: `maxLength for ${f.type} is at most ${cap}` });
      if ((f.type === "select" || f.type === "chips") && !f.options) issues.push({ path: p, code: "options_required", message: "Choice fields need options" });
    }
  }
  for (const slot of slots) {
    for (const [i, f] of (forms[slot]?.fields ?? []).entries()) {
      if (typeof f === "string" && !fieldIds.has(f))
        issues.push({ path: `forms.${slot}.fields.${i}`, code: "unknown_field", message: `No field with id "${f}"` });
    }
  }
  for (const [i, a] of (def.start?.args ?? []).entries())
    if (!fieldIds.has(a)) issues.push({ path: `start.args.${i}`, code: "unknown_field", message: `No field with id "${a}"` });
  for (const [i, q] of (def.quickAdd ?? []).entries())
    if (def.capture[q.field]?.type !== "list") issues.push({ path: `quickAdd.${i}.field`, code: "bind_unknown_path", message: `"${q.field}" isn't a list` });
  for (const [i, e] of (def.outputs?.exports ?? []).entries())
    if (e.kind === "items" && def.capture[e.from]?.type !== "list")
      issues.push({ path: `outputs.exports.${i}.from`, code: "bind_unknown_path", message: `"${e.from}" isn't a list` });
  for (const [i, t] of (def.triggers ?? []).entries())
    if (t.kind === "palette" && t.command !== `/${def.slug}`)
      issues.push({ path: `triggers.${i}.command`, code: "command_mismatch", message: `Palette command must be /${def.slug}` });
  for (const [path, layout] of [
    ["layout", def.layout],
    ["outputs.summary.layout", def.outputs?.summary?.layout],
  ] as const) {
    if (layout == null) continue;
    const r = validateSpec(layout);
    if (!r.ok) issues.push({ path, code: "layout_invalid", message: "Layout must use the Jarvis UI catalog only" });
  }
  return issues.length ? { ok: false, issues } : { ok: true, definition: def };
}

/** Resolved start-form fields in order (string refs expanded). */
export function formFields(def: WorkflowDefinition, slot: "start" | "mid" | "end"): WorkflowField[] {
  const all = new Map<string, WorkflowField>();
  for (const s of ["start", "mid", "end"] as const) for (const f of def.forms?.[s]?.fields ?? []) if (typeof f !== "string") all.set(f.id, f);
  return (def.forms?.[slot]?.fields ?? []).map((f) => (typeof f === "string" ? all.get(f) : f)).filter((f): f is WorkflowField => !!f);
}

/** Stable JSON for hashing/dedupe on import. */
export function canonicalDefinition(def: WorkflowDefinition): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(def));
}
