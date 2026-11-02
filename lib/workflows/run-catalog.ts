import { z } from "zod";
import { formFields, type WorkflowDefinition, type WorkflowField } from "./definition";

/**
 * `jarvis-ui@1.1` run + form parts (spec §4, §12.11). Closed, props strict,
 * no HTML/URLs/code. A workflow's start/mid/end forms and its run panel are
 * compiled from the stored definition into a spec of these components; the
 * model never authors layout at runtime — it only edits capture data.
 */
export const RUN_CATALOG_ID = "jarvis-ui@1.1";

const s = (n: number) => z.string().max(n);
const bind = z.string().regex(/^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*|\/-)?$/);
const base = {
  id: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/),
  bind,
  label: s(80).min(1),
  help: s(200).optional(),
  required: z.boolean().optional(),
  rememberLast: z.boolean().optional(),
  readOnly: z.boolean().optional(),
};

export const runComponentSchemas = {
  TextField: z.object({ ...base, maxLength: z.number().int().max(200).optional(), placeholder: s(80).optional() }).strict(),
  LongTextField: z.object({ ...base, maxLength: z.number().int().max(4000).optional(), rows: z.number().int().min(3).max(8).optional() }).strict(),
  ChoiceField: z
    .object({
      ...base,
      multiple: z.boolean().optional(),
      allowNew: z.boolean().optional(),
      options: z.array(z.object({ value: s(80), label: s(80) }).strict()).max(50),
    })
    .strict(),
  DateTimeField: z
    .object({
      ...base,
      mode: z.enum(["date", "time", "datetime"]),
      quick: z
        .array(z.enum(["today", "nextSunday", "serviceTime", "tomorrow"]))
        .max(4)
        .optional(),
    })
    .strict(),
  PlaceField: z.object({ ...base, geolocate: z.enum(["off", "matchSaved"]), allowTyped: z.boolean().optional() }).strict(),
  PersonField: z.object({ ...base, allowNew: z.boolean().optional() }).strict(),
  ScriptureField: z.object({ ...base, allowRange: z.boolean().optional(), mustParse: z.boolean().optional() }).strict(),
  TagsField: z.object({ ...base, max: z.number().int().min(1).max(8).optional() }).strict(),
  NumberField: z
    .object({ ...base, min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), unit: s(12).optional() })
    .strict(),
  ToggleField: z.object(base).strict(),
  Form: z.object({ title: s(80), submit: s(40), slot: z.enum(["start", "mid", "end"]) }).strict(),
  FieldGroup: z.object({ title: s(80).optional() }).strict(),
  RunHeader: z.object({ title: s(160), live: z.boolean().optional(), chips: z.array(bind).max(3).optional() }).strict(),
  Outline: z
    .object({ sections: z.array(z.object({ title: s(60), bind: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), empty: s(80).optional() }).strict()).max(12) })
    .strict(),
  QuickAddChips: z.object({ chips: z.array(z.object({ label: s(24), field: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/) }).strict()).max(8) }).strict(),
  QuoteBlock: z.object({ bind: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), showWho: z.boolean().optional() }).strict(),
} as const;

export type RunComponentName = keyof typeof runComponentSchemas;
export type RunElement = { type: RunComponentName; props: Record<string, unknown>; children?: RunElement[] };

const FIELD_COMPONENT: Record<WorkflowField["type"], RunComponentName> = {
  text: "TextField",
  longtext: "LongTextField",
  select: "ChoiceField",
  chips: "ChoiceField",
  date: "DateTimeField",
  time: "DateTimeField",
  datetime: "DateTimeField",
  place: "PlaceField",
  person: "PersonField",
  scripture: "ScriptureField",
  tags: "TagsField",
  number: "NumberField",
  toggle: "ToggleField",
} as Record<WorkflowField["type"], RunComponentName>;

function pick(f: WorkflowField, keys: string[]) {
  const o: Record<string, unknown> = {};
  for (const k of keys) if ((f as Record<string, unknown>)[k] !== undefined) o[k] = (f as Record<string, unknown>)[k];
  return o;
}

/** Compile a definition's form slot into catalog elements (validated; unknown/invalid parts dropped). */
export function compileForm(
  def: WorkflowDefinition,
  slot: "start" | "mid" | "end",
  opts: { stripLocation?: boolean; recentOptions?: Record<string, string[]> } = {},
): RunElement | null {
  const form = def.forms?.[slot];
  if (!form) return null;
  const children: RunElement[] = [];
  for (const f of formFields(def, slot)) {
    const type = FIELD_COMPONENT[f.type];
    if (!type) continue;
    const common = pick(f, ["id", "bind", "label", "help", "required", "rememberLast", "readOnly"]);
    let props: Record<string, unknown> = common;
    if (type === "TextField") props = { ...common, ...pick(f, ["maxLength", "placeholder"]) };
    if (type === "LongTextField") props = { ...common, ...pick(f, ["maxLength"]) };
    if (type === "DateTimeField") props = { ...common, mode: f.type === "date" ? "date" : f.type === "time" ? "time" : "datetime", ...pick(f, ["quick"]) };
    if (type === "PlaceField") props = { ...common, geolocate: opts.stripLocation ? "off" : (f.geolocate ?? "off"), allowTyped: true };
    if (type === "PersonField") props = { ...common, allowNew: f.allowNew ?? true };
    if (type === "ScriptureField") props = { ...common, ...pick(f, ["allowRange", "mustParse"]) };
    if (type === "TagsField") props = { ...common, ...pick(f, ["max"]) };
    if (type === "NumberField") props = { ...common, ...pick(f, ["min", "max", "step", "unit"]) };
    if (type === "ChoiceField") {
      const items = f.options?.source === "static" ? f.options.items : (opts.recentOptions?.[f.id] ?? []).map((v) => ({ value: v, label: v }));
      props = { ...common, ...pick(f, ["multiple", "allowNew"]), options: items.slice(0, 50) };
    }
    const ok = runComponentSchemas[type].safeParse(props);
    if (ok.success) children.push({ type, props: ok.data as Record<string, unknown> });
  }
  return { type: "Form", props: { title: form.title ?? def.name, submit: form.submit ?? "Start", slot }, children };
}

/** The run panel layout: header, quick-add chips, outline over the capture lists. */
export function compileRunPanel(def: WorkflowDefinition, title: string): RunElement[] {
  const lists = Object.entries(def.capture).filter(([, v]) => v.type === "list");
  const titleCase = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  const chips = (def.quickAdd ?? []).filter((q) => def.capture[q.field]?.type === "list").map((q) => ({ label: q.label, field: q.field }));
  const els: RunElement[] = [
    { type: "RunHeader", props: { title: title.slice(0, 160), live: true } },
    { type: "Outline", props: { sections: lists.slice(0, 12).map(([k]) => ({ title: titleCase(k), bind: k, empty: "Nothing yet" })) } },
  ];
  if (chips.length) els.splice(1, 0, { type: "QuickAddChips", props: { chips: chips.slice(0, 8) } });
  return els.filter((e) => runComponentSchemas[e.type].safeParse(e.props).success);
}
