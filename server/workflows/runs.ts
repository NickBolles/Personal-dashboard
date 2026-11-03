import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId, sha256 } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { getAiSettings } from "@/server/ai/settings";
import { listPeople } from "@/server/people";
import { formFields, type WorkflowDefinition } from "@/lib/workflows/definition";
import { mapPaletteArgs, parseSlashCommand } from "@/lib/workflows/palette-args";
import {
  applyOps,
  captureInstructions,
  displayValue,
  emptyCapture,
  extractCaptureBlocks,
  formToOps,
  quickDates,
  remembers,
  renderTemplate,
  resolveFormDefaults,
  splitProposals,
  undoEntries,
  validateForm,
  validateOps,
  type Capture,
  type CaptureOp,
  type LogEntry,
} from "@/lib/workflows/runs";
import { compileForm, compileRunPanel } from "@/lib/workflows/run-catalog";
import { currentDefinition, getWorkflowBySlug, refreshRoutingArea } from "./store";
import { actionsExport } from "@/lib/workflows/outputs";

const db = () => getDb();
const TZ = () => process.env.TZ || "America/Chicago";
type Ctx = { userId: string; correlationId: string };
const RECENT_KEEP = 20;

/* ---------------- saved places + remembered values (#118) ---------------- */

export function stripLocationOn() {
  return !!getAiSettings().capture?.stripLocation;
}

/** Saved places for the matcher. Coordinates go to the owner's own client only, never to AI context. */
export function listSavedPlaces(userId: string) {
  const strip = stripLocationOn();
  return db()
    .select()
    .from(schema.savedPlaces)
    .where(eq(schema.savedPlaces.ownerId, userId))
    .all()
    .map((p) => ({ id: p.id, label: p.label, addressText: p.addressText, radiusM: p.radiusM, lat: strip ? null : p.lat, lng: strip ? null : p.lng }));
}

export function savePlace(ctx: Ctx, input: { label: string; addressText?: string; lat?: number; lng?: number; radiusM?: number }) {
  const strip = stripLocationOn();
  const id = newId();
  const coords = !strip && typeof input.lat === "number" && typeof input.lng === "number";
  db()
    .insert(schema.savedPlaces)
    .values({
      id,
      ownerId: ctx.userId,
      label: input.label,
      addressText: input.addressText ?? null,
      lat: coords ? input.lat : null,
      lng: coords ? input.lng : null,
      radiusM: input.radiusM ?? 300,
    })
    .run();
  // never log coordinates
  audit({ actor: ctx.userId, action: "workflow.place.save", sourceRecord: id, result: "ok", correlationId: ctx.correlationId, detail: { withCoords: coords } });
  return { id, label: input.label, coordinatesStored: coords };
}

/** Rename a saved place (Settings → Saved places, #133). Coordinates are never touched here. */
export function renamePlace(ctx: Ctx, id: string, label: string) {
  const r = db()
    .update(schema.savedPlaces)
    .set({ label })
    .where(and(eq(schema.savedPlaces.id, id), eq(schema.savedPlaces.ownerId, ctx.userId)))
    .run();
  if (!r.changes) throw new HttpError(404, "not_found", "That place isn't saved");
  audit({ actor: ctx.userId, action: "workflow.place.rename", sourceRecord: id, result: "ok", correlationId: ctx.correlationId });
  return { id, label };
}

export function forgetPlace(ctx: Ctx, id: string) {
  const r = db()
    .delete(schema.savedPlaces)
    .where(and(eq(schema.savedPlaces.id, id), eq(schema.savedPlaces.ownerId, ctx.userId)))
    .run();
  if (!r.changes) throw new HttpError(404, "not_found", "That place isn't saved");
  audit({ actor: ctx.userId, action: "workflow.place.forget", sourceRecord: id, result: "ok", correlationId: ctx.correlationId });
  return { ok: true };
}

function ownWorkflow(userId: string, id: string) {
  const row = db()
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, id), eq(schema.workflows.ownerId, userId)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That workflow isn't here");
  return row;
}

/** Most-recent-first remembered values per field. */
export function rememberedValues(userId: string, workflowId: string): Record<string, unknown[]> {
  ownWorkflow(userId, workflowId);
  const out: Record<string, unknown[]> = {};
  for (const r of db()
    .select()
    .from(schema.rememberedFieldValues)
    .where(eq(schema.rememberedFieldValues.workflowId, workflowId))
    .orderBy(desc(schema.rememberedFieldValues.usedAt))
    .all()) {
    try {
      (out[r.fieldId] ??= []).push(JSON.parse(r.valueJson));
    } catch {
      /* skip */
    }
  }
  return out;
}

function remember(workflowId: string, fieldId: string, value: unknown) {
  const valueJson = JSON.stringify(value);
  const valueKey = sha256(valueJson);
  const at = new Date().toISOString();
  const t = schema.rememberedFieldValues;
  const prev = db()
    .select()
    .from(t)
    .where(and(eq(t.workflowId, workflowId), eq(t.fieldId, fieldId), eq(t.valueKey, valueKey)))
    .get();
  if (prev)
    db()
      .update(t)
      .set({ count: prev.count + 1, usedAt: at })
      .where(and(eq(t.workflowId, workflowId), eq(t.fieldId, fieldId), eq(t.valueKey, valueKey)))
      .run();
  else db().insert(t).values({ workflowId, fieldId, valueKey, valueJson, usedAt: at }).run();
  const rows = db()
    .select({ k: t.valueKey })
    .from(t)
    .where(and(eq(t.workflowId, workflowId), eq(t.fieldId, fieldId)))
    .orderBy(desc(t.usedAt))
    .all();
  for (const r of rows.slice(RECENT_KEEP))
    db()
      .delete(t)
      .where(and(eq(t.workflowId, workflowId), eq(t.fieldId, fieldId), eq(t.valueKey, r.k)))
      .run();
}

/** Forget remembered values: one field, or every field of the workflow. */
export function forgetRemembered(ctx: Ctx, workflowId: string, fieldId?: string) {
  ownWorkflow(ctx.userId, workflowId);
  const t = schema.rememberedFieldValues;
  const r = db()
    .delete(t)
    .where(fieldId ? and(eq(t.workflowId, workflowId), eq(t.fieldId, fieldId)) : eq(t.workflowId, workflowId))
    .run();
  audit({
    actor: ctx.userId,
    action: "workflow.remembered.forget",
    sourceRecord: workflowId,
    result: "ok",
    correlationId: ctx.correlationId,
    detail: { fieldId: fieldId ?? "*", removed: r.changes },
  });
  return { removed: r.changes };
}

/* ---------------- start form ---------------- */

function activeBySlugOrId(userId: string, ref: { slug?: string; workflowId?: string }) {
  const row = ref.workflowId
    ? ownWorkflow(userId, ref.workflowId)
    : db()
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.ownerId, userId), eq(schema.workflows.slug, (ref.slug ?? "").toLowerCase())))
        .get();
  if (!row) throw new HttpError(404, "not_found", `No workflow called /${ref.slug}`);
  if (row.status !== "active") throw new HttpError(409, "not_active", `${row.name} is a draft. Activate it in Workflows first.`);
  const def = currentDefinition(row.id, row.currentVersion);
  if (!def) throw new HttpError(409, "invalid_definition", "That workflow's definition is missing");
  // the area may have been created after import (#123)
  const areaId = refreshRoutingArea(userId, row, def, { strict: false });
  return { row: { ...row, areaId }, def };
}

/**
 * Start form (D7: always shown, prefilled, one tap Start). Defaults are
 * resolved server-side in the owner's timezone; palette args prefill.
 */
export function startForm(userId: string, input: { command?: string; workflowId?: string }, now = new Date()) {
  let slug: string | undefined;
  let rest = "";
  if (input.command) {
    const cmd = parseSlashCommand(input.command);
    if (!cmd) throw new HttpError(400, "not_a_command", "Type /name to start a workflow");
    slug = cmd.slug;
    rest = cmd.rest;
  }
  const { row, def } = activeBySlugOrId(userId, { slug, workflowId: input.workflowId });
  const places = listSavedPlaces(userId);
  const prefill = mapPaletteArgs(def, rest, { now, timezone: TZ(), savedPlaces: places.map((p) => p.label) });
  const remembered = rememberedValues(userId, row.id);
  const values = resolveFormDefaults(def, "start", { now, timezone: TZ(), remembered, prefill: prefill.values });
  const fields = formFields(def, "start").map((f) => ({
    ...f,
    quickDates: f.type === "date" || f.type === "datetime" ? quickDates(def, f, { now, timezone: TZ() }) : undefined,
    recent: (remembered[f.id] ?? []).slice(0, 6),
    geolocate: f.type === "place" && !stripLocationOn() ? (f.geolocate ?? "off") : "off",
  }));
  const people = fields.some((f) => f.type === "person")
    ? listPeople()
        .map((p) => p.name)
        .slice(0, 50)
    : [];
  return {
    workflow: { id: row.id, slug: row.slug, name: row.name, icon: row.icon, version: row.currentVersion },
    spec: compileForm(def, "start", {
      stripLocation: stripLocationOn(),
      recentOptions: Object.fromEntries(Object.entries(remembered).map(([k, v]) => [k, v.filter((x): x is string => typeof x === "string").slice(0, 6)])),
    }),
    form: { title: def.forms?.start?.title ?? `Start ${def.name}`, submit: def.forms?.start?.submit ?? "Start", fields },
    values,
    unmatched: prefill.unmatched,
    places: places.map((p) => ({ ...p, addressText: p.addressText ?? null })),
    people,
    stripLocation: stripLocationOn(),
    quickAdd: def.quickAdd ?? [],
  };
}

/* ---------------- runs ---------------- */

type RunRow = typeof schema.workflowRuns.$inferSelect;

function parse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function ownRun(userId: string, id: string): { row: RunRow; def: WorkflowDefinition } {
  const row = db()
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowRuns.ownerId, userId)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That run isn't here");
  const def = currentDefinition(row.workflowId, row.version);
  if (!def) throw new HttpError(409, "invalid_definition", "That run's workflow version is missing");
  return { row, def };
}

export function runView(row: RunRow, def: WorkflowDefinition) {
  const log = parse<LogEntry[]>(row.captureLogJson, []);
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    title: row.title,
    status: row.status,
    conversationId: row.conversationId,
    itemId: row.itemId,
    areaId: row.areaId,
    areaTitle: row.areaId
      ? (db().select({ title: schema.workItems.title }).from(schema.workItems).where(eq(schema.workItems.id, row.areaId)).get()?.title ?? null)
      : null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    capture: parse<Capture>(row.captureJson, {}),
    log: log.slice(-50).map((e) => ({ id: e.id, at: e.at, by: e.by, source: e.source, op: e.op, undone: !!e.undone })),
    proposals: parse<CaptureOp[]>(row.proposalsJson, []),
    context: row.status === "live" ? runContext(def, row.version, parse<Capture>(row.captureJson, {})) : null,
    panel: compileRunPanel(def, row.title),
    definition: {
      name: def.name,
      slug: def.slug,
      capture: def.capture,
      quickAdd: def.quickAdd ?? [],
      mid: formFields(def, "mid"),
      end: formFields(def, "end"),
      reflectionPrompts: def.reflectionPrompts ?? "off",
      // the list the action checklist promotes from (`outputs.exports[].from`, same as promotePlan; #146)
      itemsFrom: actionsExport(def)?.from ?? null,
    },
    summary: row.summary ?? null,
    summaryState: row.summaryState as "none" | "proposed" | "accepted",
    promoted: parse<{ index: number; itemId: string; title: string }[]>(row.promotedJson, []),
    driveExport: parse<{ url: string; path: string; name: string; kind: "doc" | "markdown"; savedAt: string } | null>(row.driveExportJson ?? "null", null),
  };
}

/**
 * Start a run from the submitted start form. Validates (server wins),
 * writes form values as `by:user source:form:start` ops, remembers values
 * (D11), and returns the first message + run context for the chat.
 */
export function startRun(ctx: Ctx, input: { workflowId: string; values: Record<string, unknown>; triggeredBy?: string }, now = new Date()) {
  const { row: wf, def } = activeBySlugOrId(ctx.userId, { workflowId: input.workflowId });
  const errors = validateForm(def, "start", input.values);
  if (errors.length) throw Object.assign(new HttpError(422, "invalid_form", errors[0].message), { details: { errors } });
  const ops = formToOps(def, "start", input.values);
  const v = validateOps(def, emptyCapture(def), ops);
  const id = newId();
  let n = 0;
  const applied = applyOps(def, emptyCapture(def), v.ops, { by: "user", source: "form:start", at: now.toISOString(), id: () => `${id}-${n++}` });
  const title = (def.start?.prompt ? renderTemplate(def.start.prompt, applied.capture) : "") || def.name;
  db()
    .insert(schema.workflowRuns)
    .values({
      id,
      ownerId: ctx.userId,
      workflowId: wf.id,
      version: wf.currentVersion,
      areaId: wf.areaId,
      title: title.slice(0, 160),
      captureJson: JSON.stringify(applied.capture),
      captureLogJson: JSON.stringify(applied.entries),
      triggeredBy: input.triggeredBy ?? "palette",
    })
    .run();
  for (const f of formFields(def, "start")) {
    const val = input.values[f.id];
    if (remembers(f) && val !== undefined && val !== null && val !== "" && !(Array.isArray(val) && !val.length)) remember(wf.id, f.id, val);
  }
  audit({
    actor: ctx.userId,
    action: "workflow.run.start",
    sourceRecord: id,
    result: "ok",
    correlationId: ctx.correlationId,
    detail: { workflowId: wf.id, version: wf.currentVersion, dropped: v.dropped.length },
  });
  const context = runContext(def, wf.currentVersion, applied.capture);
  const run = ownRun(ctx.userId, id);
  return { run: runView(run.row, run.def), input: title, context, areaId: wf.areaId };
}

/**
 * Run context sent with each turn (#119: Hermes /v1/runs has no per-session
 * system prompt in Jarvis yet, so instructions ride as run context ≤ 4000).
 * The model only sees labels — never coordinates, never the People list.
 */
export function runContext(def: WorkflowDefinition, version: number, capture: Capture): string {
  const session = Object.entries(capture)
    .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  // start-form list values (e.g. the main passage bound to /scripture/-) belong in the context too (#135)
  const startLists = new Set(
    formFields(def, "start")
      .filter((f) => f.bind.endsWith("/-"))
      .map((f) => f.bind.slice(0, -2)),
  );
  const lists = [...startLists]
    .filter((k) => Array.isArray(capture[k]) && (capture[k] as unknown[]).length)
    .map((k) => `${k}: ${(capture[k] as unknown[]).map(displayValue).join("; ")}`.slice(0, 600))
    .join("\n");
  const head = `Workflow: ${def.name} (/${def.slug}, v${version}).`;
  // the capture protocol and session facts are reserved; long instructions are trimmed instead (#135)
  const tail = [captureInstructions(def), session, lists].filter(Boolean).join("\n\n");
  const room = Math.max(0, 4000 - head.length - tail.length - 4);
  return [head, def.instructions.slice(0, room), tail].filter(Boolean).join("\n\n").slice(0, 4000);
}

/** Next numeric log-id suffix: independent of the retained (last 1000) log length (#135). */
function nextLogSeq(runId: string, log: LogEntry[]): number {
  let max = log.length - 1;
  for (const e of log) {
    const m = typeof e.id === "string" && e.id.startsWith(`${runId}-`) ? Number(e.id.slice(runId.length + 1)) : NaN;
    if (Number.isInteger(m) && m > max) max = m;
  }
  return max + 1;
}

export function getRun(userId: string, id: string) {
  const { row, def } = ownRun(userId, id);
  return runView(row, def);
}

export function runForConversation(userId: string, conversationId: string) {
  const row = db()
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.ownerId, userId), eq(schema.workflowRuns.conversationId, conversationId)))
    .orderBy(desc(schema.workflowRuns.startedAt))
    .get();
  if (!row) return null;
  const def = currentDefinition(row.workflowId, row.version);
  return def ? runView(row, def) : null;
}

function save(row: RunRow, patch: Partial<RunRow>) {
  db()
    .update(schema.workflowRuns)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.workflowRuns.id, row.id))
    .run();
}

export function linkConversation(ctx: Ctx, id: string, conversationId: string) {
  const { row } = ownRun(ctx.userId, id);
  if (row.conversationId && row.conversationId !== conversationId) throw new HttpError(409, "already_linked", "This run already has a conversation");
  save(row, { conversationId });
  return getRun(ctx.userId, id);
}

/**
 * Apply capture changes. `by:user` = direct edits/quick-add; `by:agent` =
 * the assistant's reply text — only fenced jarvis-capture ops on declared
 * paths are read; form-bound fields with `propose:true` wait for a tap.
 */
export function patchRun(ctx: Ctx, id: string, input: { by: "user"; ops: unknown; source?: string } | { by: "agent"; text: string; messageId?: string }) {
  const { row, def } = ownRun(ctx.userId, id);
  if (row.status !== "live") throw new HttpError(409, "run_ended", "This session has ended");
  // an assistant turn is read once (the client may report it again after a refetch)
  const agentSource = input.by === "agent" && input.messageId ? `agent:${input.messageId}` : "agent";
  if (agentSource !== "agent" && parse<LogEntry[]>(row.captureLogJson, []).some((e) => e.source === agentSource))
    return { run: runView(row, def), applied: [] as string[], dropped: 0, proposed: 0 };
  const capture = parse<Capture>(row.captureJson, emptyCapture(def));
  let raw: unknown;
  let propose = false;
  let parseErrors = 0;
  if (input.by === "agent") {
    const x = extractCaptureBlocks(input.text);
    raw = x.ops;
    propose = x.propose;
    parseErrors = x.errors;
  } else raw = input.ops;
  const v = validateOps(def, capture, raw);
  const { apply, proposed } = splitProposals(def, v.ops, propose);
  const log = parse<LogEntry[]>(row.captureLogJson, []);
  let n = nextLogSeq(row.id, log);
  let applied;
  try {
    applied = applyOps(def, capture, apply, {
      by: input.by,
      source: input.by === "user" ? input.source : agentSource,
      at: new Date().toISOString(),
      id: () => `${row.id}-${n++}`,
    });
  } catch {
    throw new HttpError(413, "capture_too_large", "This session's notes are full");
  }
  const prior = parse<CaptureOp[]>(row.proposalsJson, []);
  const seen = new Set(prior.map((o) => JSON.stringify(o)));
  const proposals = [...prior, ...proposed.filter((o) => !seen.has(JSON.stringify(o)))].slice(-20);
  save(row, {
    captureJson: JSON.stringify(applied.capture),
    captureLogJson: JSON.stringify([...log, ...applied.entries].slice(-1000)),
    proposalsJson: JSON.stringify(proposals),
  });
  audit({
    actor: ctx.userId,
    action: "workflow.run.capture",
    sourceRecord: id,
    result: "ok",
    correlationId: ctx.correlationId,
    detail: { by: input.by, applied: applied.entries.length, proposed: proposed.length, dropped: v.dropped.length + parseErrors },
  });
  return { run: getRun(ctx.userId, id), applied: applied.entries.map((e) => e.id), dropped: v.dropped.length + parseErrors, proposed: proposed.length };
}

export function resolveProposals(ctx: Ctx, id: string, input: { accept: number[]; clear?: boolean }) {
  const { row, def } = ownRun(ctx.userId, id);
  const proposals = parse<CaptureOp[]>(row.proposalsJson, []);
  const picked = input.accept.map((i) => proposals[i]).filter(Boolean);
  const rest = input.clear ? [] : proposals.filter((_, i) => !input.accept.includes(i));
  save(row, { proposalsJson: JSON.stringify(rest) });
  if (!picked.length) return { run: runView({ ...row, proposalsJson: JSON.stringify(rest) }, def), applied: [] as string[], dropped: 0, proposed: 0 };
  return patchRun(ctx, id, { by: "user", ops: picked, source: "proposal" });
}

export function undoRun(ctx: Ctx, id: string, entryIds: string[]) {
  const { row, def } = ownRun(ctx.userId, id);
  if (row.status !== "live") throw new HttpError(409, "run_ended", "This session has ended");
  const capture = parse<Capture>(row.captureJson, emptyCapture(def));
  const log = parse<LogEntry[]>(row.captureLogJson, []);
  const latest = [...log].reverse().find((e) => !e.undone && e.source !== "form:start");
  const ids = entryIds.length ? entryIds : latest ? [latest.id] : [];
  const r = undoEntries(def, capture, log, ids);
  save(row, { captureJson: JSON.stringify(r.capture), captureLogJson: JSON.stringify(r.log) });
  audit({
    actor: ctx.userId,
    action: "workflow.run.undo",
    sourceRecord: id,
    result: r.failed.length ? "rejected" : "ok",
    correlationId: ctx.correlationId,
    detail: { undone: r.undone.length, failed: r.failed.length },
  });
  return { run: getRun(ctx.userId, id), undone: r.undone, failed: r.failed };
}

/** End session (summary/export is W4). Never settles anything. */
export function endRun(ctx: Ctx, id: string) {
  const { row } = ownRun(ctx.userId, id);
  if (row.status === "live") save(row, { status: "ended", endedAt: new Date().toISOString() });
  audit({ actor: ctx.userId, action: "workflow.run.end", sourceRecord: id, result: "ok", correlationId: ctx.correlationId });
  return getRun(ctx.userId, id);
}

export function listRuns(userId: string, workflowId?: string) {
  const t = schema.workflowRuns;
  return db()
    .select({
      id: t.id,
      workflowId: t.workflowId,
      title: t.title,
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      conversationId: t.conversationId,
    })
    .from(t)
    .where(workflowId ? and(eq(t.ownerId, userId), eq(t.workflowId, workflowId)) : eq(t.ownerId, userId))
    .orderBy(desc(t.startedAt))
    .limit(50)
    .all();
}

export { getWorkflowBySlug, ownRun, save as saveRun, parse as parseJson };
export type { RunRow, Ctx as RunCtx };
