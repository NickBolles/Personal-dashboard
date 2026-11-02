/**
 * Workflow builder state (W3). Pure reducer over a draft `jarvis-workflow@1`
 * definition: the builder UI dispatches actions, the preview and the inline
 * errors read `validateDefinition(state.draft)`. Nothing here talks to the
 * server; Save sends `state.draft` to PUT /api/workflows/:id (new immutable
 * version) or POST /api/workflows (v1).
 */
import {
  FIELD_TYPES,
  WORKFLOW_FORMAT,
  validateDefinition,
  type DefinitionIssue,
  type FieldType,
  type WorkflowDefinition,
  type WorkflowField,
} from "./definition";

export type FormSlot = "start" | "mid" | "end";
export type DefaultSource =
  | { kind: "none" }
  | { kind: "literal"; value: string }
  | { kind: "smart"; source: "$today" | "$now" | "$tomorrow" | "$nextSunday" | "$serviceTime" }
  | { kind: "last" };
export type BuilderSection = "basics" | "instructions" | "capture" | "forms" | "layout" | "outputs";
export const BUILDER_SECTIONS: BuilderSection[] = ["basics", "instructions", "capture", "forms", "layout", "outputs"];

export type BuilderState = {
  draft: WorkflowDefinition;
  /** version the draft was loaded from (null = new workflow) */
  baseVersion: number | null;
  section: BuilderSection;
  formSlot: FormSlot;
  selectedField: string | null;
  previewMode: "defaults" | "empty" | "errors";
  dirty: boolean;
  /** undo stack of previous drafts (bounded) */
  past: WorkflowDefinition[];
};

export type BuilderAction =
  | { type: "load"; definition: WorkflowDefinition; version: number | null }
  | { type: "section"; section: BuilderSection }
  | {
      type: "basics";
      patch: Partial<Pick<WorkflowDefinition, "name" | "slug" | "icon" | "description">> & {
        area?: string | null;
        modelTier?: WorkflowDefinition["routing"]["modelTier"];
        agentProfile?: string | null;
      };
    }
  | { type: "instructions"; text: string }
  | { type: "captureAdd"; key: string; spec: "text" | "list" }
  | { type: "captureRemove"; key: string }
  | { type: "formSlot"; slot: FormSlot }
  | { type: "fieldAdd"; slot: FormSlot; fieldType: FieldType; bind?: string }
  | { type: "fieldUpdate"; slot: FormSlot; id: string; patch: Partial<Omit<WorkflowField, "id" | "type">> }
  | { type: "fieldDefault"; slot: FormSlot; id: string; source: DefaultSource }
  | { type: "fieldRemove"; slot: FormSlot; id: string }
  | { type: "fieldMove"; slot: FormSlot; id: string; delta: -1 | 1 }
  | { type: "fieldSelect"; id: string | null }
  | { type: "argsSet"; ids: string[] }
  | { type: "preview"; mode: BuilderState["previewMode"] }
  | { type: "undo" }
  | { type: "saved"; version: number };

const MAX_PAST = 50;

export function blankDefinition(name = "New workflow", slug = "new-workflow"): WorkflowDefinition {
  return {
    format: WORKFLOW_FORMAT,
    name,
    slug,
    icon: "sparkles" as WorkflowDefinition["icon"],
    routing: { area: null, agentProfile: null, modelTier: "fast" },
    instructions: "Organise my notes as I go.",
    capture: { notes: { type: "list", of: "text" } },
    policy: { settle: "manual", aiContext: "workflow_only" },
  };
}

export function initBuilder(definition: WorkflowDefinition = blankDefinition(), version: number | null = null): BuilderState {
  return {
    draft: definition,
    baseVersion: version,
    section: "basics",
    formSlot: "start",
    selectedField: null,
    previewMode: "defaults",
    dirty: false,
    past: [],
  };
}

/** Rough token count for the instructions editor (≈ 4 chars/token, words as a floor). */
export function tokenCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return Math.max(t.split(/\s+/).length, Math.ceil(t.length / 4));
}

/** capture key → readable label ("teachingPoints" → "Teaching points") */
export function labelFor(key: string): string {
  const s = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const FIELD_CAPTURE: Partial<Record<FieldType, string>> = {
  text: "text",
  longtext: "longtext",
  date: "date",
  datetime: "datetime",
  time: "time",
  number: "number",
  toggle: "bool",
  scripture: "scripture_ref",
  place: "place",
  person: "person",
  tags: "tags",
};

function uniqueId(base: string, taken: Set<string>) {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}${i}`;
  return id;
}

function allFieldIds(def: WorkflowDefinition): Set<string> {
  const s = new Set<string>();
  for (const slot of ["start", "mid", "end"] as const) for (const f of def.forms?.[slot]?.fields ?? []) if (typeof f !== "string") s.add(f.id);
  return s;
}

function withFields(def: WorkflowDefinition, slot: FormSlot, fn: (fields: (WorkflowField | string)[]) => (WorkflowField | string)[]): WorkflowDefinition {
  const forms = { ...(def.forms ?? {}) };
  const current = forms[slot];
  const fields = fn([...(current?.fields ?? [])]);
  if (fields.length === 0) delete forms[slot];
  else forms[slot] = { ...(current ?? {}), fields };
  const out: WorkflowDefinition = { ...def, forms };
  if (Object.keys(forms).length === 0) delete out.forms;
  return out;
}

function mapField(def: WorkflowDefinition, slot: FormSlot, id: string, fn: (f: WorkflowField) => WorkflowField) {
  return withFields(def, slot, (fields) => fields.map((f) => (typeof f !== "string" && f.id === id ? fn(f) : f)));
}

export function defaultFromSource(source: DefaultSource): WorkflowField["default"] | undefined {
  switch (source.kind) {
    case "none":
      return undefined;
    case "literal":
      return { value: source.value };
    case "smart":
      return { source: source.source };
    case "last":
      return { source: "last" };
  }
}

export function sourceOfDefault(d: WorkflowField["default"]): DefaultSource {
  if (!d) return { kind: "none" };
  if ("value" in d && !("source" in d)) return { kind: "literal", value: String(d.value) };
  if ("source" in d && d.source === "last") return { kind: "last" };
  if ("source" in d && typeof d.source === "string" && d.source.startsWith("$"))
    return { kind: "smart", source: d.source as Extract<DefaultSource, { kind: "smart" }>["source"] };
  return { kind: "none" };
}

function edit(state: BuilderState, draft: WorkflowDefinition, extra: Partial<BuilderState> = {}): BuilderState {
  if (draft === state.draft) return { ...state, ...extra };
  return { ...state, ...extra, draft, dirty: true, past: [...state.past, state.draft].slice(-MAX_PAST) };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  const d = state.draft;
  switch (action.type) {
    case "load":
      return initBuilder(action.definition, action.version);
    case "section":
      return { ...state, section: action.section };
    case "formSlot":
      return { ...state, formSlot: action.slot, selectedField: null };
    case "fieldSelect":
      return { ...state, selectedField: action.id };
    case "preview":
      return { ...state, previewMode: action.mode };
    case "saved":
      return { ...state, baseVersion: action.version, dirty: false };
    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { ...state, draft: prev, past: state.past.slice(0, -1), dirty: true };
    }
    case "basics": {
      const { area, modelTier, agentProfile, ...rest } = action.patch;
      const routing = { ...d.routing };
      if (area !== undefined) routing.area = area;
      if (modelTier !== undefined) routing.modelTier = modelTier;
      if (agentProfile !== undefined) routing.agentProfile = agentProfile;
      const next = { ...d, ...rest, routing };
      // keep the palette trigger in step with the slug (validator requires /slug)
      if (rest.slug && next.triggers) next.triggers = next.triggers.map((t) => (t.kind === "palette" ? { ...t, command: `/${rest.slug}` } : t));
      return edit(state, next);
    }
    case "instructions":
      return edit(state, { ...d, instructions: action.text });
    case "captureAdd": {
      if (d.capture[action.key]) return state;
      const entry = action.spec === "list" ? { type: "list" as const, of: "text" } : { type: "object" as const, fields: { value: "text?" } };
      return edit(state, { ...d, capture: { ...d.capture, [action.key]: entry } });
    }
    case "captureRemove": {
      if (!d.capture[action.key]) return state;
      const capture = { ...d.capture };
      delete capture[action.key];
      return edit(state, { ...d, capture });
    }
    case "fieldAdd": {
      if (!FIELD_TYPES.includes(action.fieldType)) return state;
      const id = uniqueId(action.fieldType === "longtext" ? "notes" : action.fieldType, allFieldIds(d));
      let draft = d;
      let bind = action.bind;
      if (!bind) {
        // auto-create a capture slot under "session" so the new field validates
        const scalar = FIELD_CAPTURE[action.fieldType] ?? "text";
        const session = d.capture.session?.type === "object" ? d.capture.session : { type: "object" as const, fields: {} as Record<string, string> };
        draft = { ...d, capture: { ...d.capture, session: { ...session, fields: { ...session.fields, [id]: `${scalar}?` } } } };
        bind = `session.${id}`;
      }
      const field: WorkflowField = { id, bind, type: action.fieldType, label: labelFor(id) };
      if (action.fieldType === "select" || action.fieldType === "chips") field.options = { source: "static", items: [{ value: "one", label: "One" }] };
      draft = withFields(draft, action.slot, (fields) => [...fields, field]);
      return edit(state, draft, { selectedField: id, formSlot: action.slot });
    }
    case "fieldUpdate":
      return edit(
        state,
        mapField(d, action.slot, action.id, (f) => ({ ...f, ...action.patch })),
      );
    case "fieldDefault":
      return edit(
        state,
        mapField(d, action.slot, action.id, (f) => {
          const def = defaultFromSource(action.source);
          const out = { ...f };
          if (def) out.default = def;
          else delete out.default;
          if (action.source.kind === "last") out.rememberLast = true;
          return out;
        }),
      );
    case "fieldRemove": {
      let draft = withFields(d, action.slot, (fields) => fields.filter((f) => (typeof f === "string" ? f : f.id) !== action.id));
      // drop references to the removed field (other forms' string refs, palette args)
      if (!allFieldIds(draft).has(action.id)) {
        for (const slot of ["start", "mid", "end"] as const) draft = withFields(draft, slot, (fields) => fields.filter((f) => f !== action.id));
        if (draft.start?.args) draft = { ...draft, start: { ...draft.start, args: draft.start.args.filter((a) => a !== action.id) } };
      }
      return edit(state, draft, { selectedField: state.selectedField === action.id ? null : state.selectedField });
    }
    case "fieldMove":
      return edit(
        state,
        withFields(d, action.slot, (fields) => {
          const i = fields.findIndex((f) => (typeof f === "string" ? f : f.id) === action.id);
          const j = i + action.delta;
          if (i < 0 || j < 0 || j >= fields.length) return fields;
          [fields[i], fields[j]] = [fields[j], fields[i]];
          return fields;
        }),
      );
    case "argsSet":
      return edit(state, { ...d, start: { ...(d.start ?? {}), args: action.ids.slice(0, 6) } });
  }
}

/** Validator issues grouped by builder section for inline errors. */
export function issuesBySection(def: WorkflowDefinition, opts: { excludedAreas?: string[] } = {}): Record<BuilderSection, DefinitionIssue[]> {
  const out: Record<BuilderSection, DefinitionIssue[]> = { basics: [], instructions: [], capture: [], forms: [], layout: [], outputs: [] };
  const r = validateDefinition(def, opts);
  if (r.ok) return out;
  for (const i of r.issues) {
    const head = i.path.split(".")[0];
    const section: BuilderSection =
      head === "instructions"
        ? "instructions"
        : head === "capture" || head === "quickAdd"
          ? "capture"
          : head === "forms" || head === "start"
            ? "forms"
            : head === "layout"
              ? "layout"
              : head === "outputs" || head === "triggers"
                ? "outputs"
                : "basics";
    out[section].push(i);
  }
  return out;
}
