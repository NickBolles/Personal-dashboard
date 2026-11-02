import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId, sha256 } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { listItems } from "@/server/work/store";
import { BUILT_IN_SURFACE_KINDS } from "@/lib/jarvis-ui/types";
import { diffDefinitions, restoreDefinition, restoreNote, summarizeDiff } from "@/lib/workflows/versions";
import { canonicalDefinition, validateDefinition, WORKFLOW_FORMAT, type DefinitionIssue, type WorkflowDefinition } from "@/lib/workflows/definition";

export type WorkflowStatus = "draft" | "active" | "archived";
export type WorkflowSummary = {
  id: string;
  slug: string;
  name: string;
  icon: string;
  hue: string | null;
  status: WorkflowStatus;
  currentVersion: number;
  area: string | null;
  areaId: string | null;
  description: string | null;
  triggers: string[];
  builtIn: false;
  updatedAt: string;
};
export type BuiltInWorkflow = { kind: string; slug: string; name: string; description: string; href: string; builtIn: true };

/** Built-in surfaces (code-defined, read-only) shown in the same gallery. */
export const BUILT_IN_WORKFLOWS: BuiltInWorkflow[] = BUILT_IN_SURFACE_KINDS.map((kind) => {
  const meta = {
    brief: { name: "Morning brief", description: "Today's priorities, calendar and approvals in one card.", href: "/home" },
    week: { name: "Week plan", description: "Plan the week and block time on the calendar (asks first).", href: "/home" },
    pr: { name: "PR review card", description: "A pull request's status, checks and review notes.", href: "/areas" },
  }[kind];
  return { kind, slug: kind, ...meta, builtIn: true as const };
});

const db = () => getDb();

/** Area paths ("Faith", "Work/Jarvis") → item id, plus the areas AI can't use (Finance / aiPolicy=excluded). */
function areaIndex(userId: string) {
  const items = listItems(userId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const path = (id: string): string => {
    const i = byId.get(id);
    if (!i) return "";
    return i.parentId ? `${path(i.parentId)}/${i.title}` : i.title;
  };
  const containers = items.filter((i) => i.parentId === null || i.kind === "area" || i.kind === "project");
  const paths = new Map(containers.map((i) => [path(i.id).toLowerCase(), i]));
  const excluded = containers.filter((i) => /^finance$/i.test(i.title) || i.settings?.aiPolicy === "excluded").map((i) => path(i.id));
  return { paths, excluded, path };
}

function validateFor(userId: string, raw: unknown) {
  const areas = areaIndex(userId);
  const r = validateDefinition(raw, { excludedAreas: areas.excluded });
  if (!r.ok) return { ...r, areaId: null as string | null, areaFound: false };
  const area = r.definition.routing.area;
  const hit = area ? areas.paths.get(area.toLowerCase()) : undefined;
  // an excluded descendant (e.g. "Finance/Bills") is excluded too
  if (area && areas.excluded.some((x) => area.toLowerCase().startsWith(`${x.toLowerCase()}/`))) {
    return {
      ok: false as const,
      issues: [{ path: "routing.area", code: "finance_excluded", message: "Workflows can't use Finance or AI-excluded areas" }],
      areaId: null,
      areaFound: false,
    };
  }
  return { ...r, areaId: hit?.id ?? null, areaFound: !area || !!hit };
}

export class WorkflowValidationError extends HttpError {
  constructor(public issues: DefinitionIssue[]) {
    super(422, "invalid_definition", issues[0]?.message ?? "That workflow isn't valid");
  }
}

function toSummary(row: typeof schema.workflows.$inferSelect, def: WorkflowDefinition | null): WorkflowSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    hue: row.hue,
    status: row.status as WorkflowStatus,
    currentVersion: row.currentVersion,
    area: def?.routing.area ?? null,
    areaId: row.areaId,
    description: def?.description ?? null,
    triggers: (def?.triggers ?? []).map((t) => (t.kind === "palette" ? t.command : t.kind)),
    builtIn: false,
    updatedAt: row.updatedAt,
  };
}

export function currentDefinition(workflowId: string, version: number): WorkflowDefinition | null {
  const v = db()
    .select()
    .from(schema.workflowVersions)
    .where(and(eq(schema.workflowVersions.workflowId, workflowId), eq(schema.workflowVersions.version, version)))
    .get();
  if (!v) return null;
  try {
    return JSON.parse(v.definitionJson) as WorkflowDefinition;
  } catch {
    return null;
  }
}

function own(userId: string, id: string) {
  const row = db()
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, id), eq(schema.workflows.ownerId, userId)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That workflow isn't here");
  return row;
}

export function listWorkflows(userId: string, opts: { includeArchived?: boolean } = {}): WorkflowSummary[] {
  return db()
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.ownerId, userId))
    .orderBy(desc(schema.workflows.updatedAt))
    .all()
    .filter((r) => opts.includeArchived || r.status !== "archived")
    .map((r) => toSummary(r, currentDefinition(r.id, r.currentVersion)));
}

export function getWorkflow(userId: string, id: string) {
  const row = own(userId, id);
  const definition = currentDefinition(row.id, row.currentVersion);
  const versions = db()
    .select({
      version: schema.workflowVersions.version,
      createdAt: schema.workflowVersions.createdAt,
      createdBy: schema.workflowVersions.createdBy,
      changeNote: schema.workflowVersions.changeNote,
    })
    .from(schema.workflowVersions)
    .where(eq(schema.workflowVersions.workflowId, row.id))
    .orderBy(desc(schema.workflowVersions.version))
    .all();
  return { workflow: toSummary(row, definition), definition, versions };
}

export function getWorkflowBySlug(userId: string, slug: string) {
  const row = db()
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.ownerId, userId), eq(schema.workflows.slug, slug.toLowerCase())))
    .get();
  if (!row) return null;
  return { row, workflow: toSummary(row, currentDefinition(row.id, row.currentVersion)), definition: currentDefinition(row.id, row.currentVersion) };
}

type Ctx = { userId: string; correlationId: string };

/** Create from a definition. Imports and API creates always start as draft (one activation tap; instructions are prompt text). */
export function createWorkflow(ctx: Ctx, raw: unknown, opts: { source: "create" | "import"; changeNote?: string } = { source: "create" }) {
  const r = validateFor(ctx.userId, raw);
  if (!r.ok) {
    audit({
      actor: ctx.userId,
      action: `workflow.${opts.source}`,
      result: "rejected",
      correlationId: ctx.correlationId,
      detail: { issues: r.issues.slice(0, 5).map((i) => i.code) },
    });
    throw new WorkflowValidationError(r.issues);
  }
  const def = r.definition;
  const hash = sha256(canonicalDefinition(def));
  const existing = db()
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.ownerId, ctx.userId), eq(schema.workflows.slug, def.slug)))
    .get();
  if (existing) {
    if (existing.definitionHash === hash) return { ...getWorkflow(ctx.userId, existing.id), duplicate: true, areaFound: r.areaFound };
    throw new HttpError(409, "slug_taken", `You already have a workflow called /${def.slug}`);
  }
  const id = newId("wf");
  const tx = db();
  tx.transaction((t) => {
    t.insert(schema.workflows)
      .values({
        id,
        ownerId: ctx.userId,
        slug: def.slug,
        name: def.name,
        icon: def.icon,
        hue: def.hue ?? null,
        areaId: r.areaId,
        status: "draft",
        currentVersion: 1,
        definitionHash: hash,
      })
      .run();
    t.insert(schema.workflowVersions)
      .values({
        workflowId: id,
        version: 1,
        createdBy: opts.source === "import" ? "import" : ctx.userId,
        changeNote: opts.changeNote ?? (opts.source === "import" ? "Imported" : "Created"),
        definitionJson: JSON.stringify(def),
      })
      .run();
  });
  audit({
    actor: ctx.userId,
    action: `workflow.${opts.source}`,
    sourceRecord: id,
    result: "ok",
    correlationId: ctx.correlationId,
    detail: { slug: def.slug, version: 1 },
  });
  return { ...getWorkflow(ctx.userId, id), duplicate: false, areaFound: r.areaFound };
}

/** Save a new immutable version. The slug can't change (it's the /command). */
export function saveVersion(ctx: Ctx, id: string, raw: unknown, changeNote?: string) {
  const row = own(ctx.userId, id);
  const r = validateFor(ctx.userId, raw);
  if (!r.ok) throw new WorkflowValidationError(r.issues);
  const def = r.definition;
  if (def.slug !== row.slug) throw new HttpError(422, "slug_locked", "The /command can't change; duplicate the workflow instead");
  const hash = sha256(canonicalDefinition(def));
  if (hash === row.definitionHash) return getWorkflow(ctx.userId, id);
  const version = row.currentVersion + 1;
  db().transaction((t) => {
    t.insert(schema.workflowVersions)
      .values({ workflowId: id, version, createdBy: ctx.userId, changeNote: changeNote?.slice(0, 200) ?? null, definitionJson: JSON.stringify(def) })
      .run();
    t.update(schema.workflows)
      .set({
        name: def.name,
        icon: def.icon,
        hue: def.hue ?? null,
        areaId: r.areaId,
        currentVersion: version,
        definitionHash: hash,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
  });
  audit({ actor: ctx.userId, action: "workflow.version", sourceRecord: id, result: "ok", correlationId: ctx.correlationId, detail: { version } });
  return getWorkflow(ctx.userId, id);
}

/**
 * Re-resolve `routing.area` against the CURRENT areas (#123): an area created
 * (or renamed to match) after import gets picked up on activation/start
 * instead of filing chats in Miscellaneous forever. Throws when the area has
 * become Finance/AI-excluded. Returns the (possibly updated) area id.
 */
export function refreshRoutingArea(
  userId: string,
  row: typeof schema.workflows.$inferSelect,
  def?: WorkflowDefinition | null,
  opts: { strict?: boolean } = { strict: true },
): string | null {
  const d = def ?? currentDefinition(row.id, row.currentVersion);
  const r = validateFor(userId, d);
  if (!r.ok) {
    // at start only the Finance/AI-excluded check blocks; other issues were accepted when the version was saved
    if (opts.strict || r.issues.some((i) => i.code === "finance_excluded")) throw new WorkflowValidationError(r.issues);
    return row.areaId;
  }
  // only a found path moves the area; an unknown path keeps whatever was stored
  const next = r.areaFound && r.definition.routing.area ? r.areaId : row.areaId;
  if (next !== row.areaId) db().update(schema.workflows).set({ areaId: next }).where(eq(schema.workflows.id, row.id)).run();
  return next;
}

export function setWorkflowStatus(ctx: Ctx, id: string, status: WorkflowStatus) {
  const row = own(ctx.userId, id);
  // re-check against current areas (an area may have become Finance-excluded, or been created, since import)
  if (status === "active") refreshRoutingArea(ctx.userId, row);
  db().update(schema.workflows).set({ status, updatedAt: new Date().toISOString() }).where(eq(schema.workflows.id, id)).run();
  audit({
    actor: ctx.userId,
    action: `workflow.${status === "active" ? "activate" : status === "archived" ? "archive" : "draft"}`,
    sourceRecord: id,
    result: "ok",
    correlationId: ctx.correlationId,
  });
  return getWorkflow(ctx.userId, id);
}

/** Export: `jarvis-workflow@1` definitions (current version), one or all. */
export function exportWorkflows(userId: string, ids?: string[]) {
  const rows = listWorkflows(userId, { includeArchived: true }).filter((w) => !ids || ids.includes(w.id));
  return {
    format: "jarvis-workflow-export@1",
    exportedAt: new Date().toISOString(),
    workflows: rows.map((w) => getWorkflow(userId, w.id).definition).filter((d): d is WorkflowDefinition => !!d && d.format === WORKFLOW_FORMAT),
  };
}

/** Import one definition or an export bundle; each arrives as a draft. Returns per-definition results. */
export function importWorkflows(ctx: Ctx, raw: unknown) {
  const list: unknown[] =
    raw && typeof raw === "object" && Array.isArray((raw as { workflows?: unknown }).workflows) ? (raw as { workflows: unknown[] }).workflows : [raw];
  if (list.length > 20) throw new HttpError(422, "too_many", "Import at most 20 workflows at a time");
  return list.map((def) => {
    try {
      const r = createWorkflow(ctx, def, { source: "import" });
      return { ok: true as const, id: r.workflow.id, slug: r.workflow.slug, duplicate: r.duplicate, areaFound: r.areaFound };
    } catch (e) {
      if (e instanceof WorkflowValidationError) return { ok: false as const, code: e.code, issues: e.issues.slice(0, 10) };
      if (e instanceof HttpError) return { ok: false as const, code: e.code, issues: [{ path: "", code: e.code, message: e.message }] };
      throw e;
    }
  });
}

/** One immutable version with a diff against the version before it (builder history). */
export function getVersion(userId: string, id: string, version: number) {
  const row = own(userId, id);
  const definition = currentDefinition(row.id, version);
  if (!definition) throw new HttpError(404, "not_found", `Version ${version} isn't here`);
  const previous = version > 1 ? currentDefinition(row.id, version - 1) : null;
  const changes = diffDefinitions(previous, definition);
  return { version, current: row.currentVersion, definition, changes, summary: summarizeDiff(changes) };
}

/** Restore = save the old definition as a NEW version (history is never rewritten). */
export function restoreVersion(ctx: Ctx, id: string, version: number) {
  const row = own(ctx.userId, id);
  const old = currentDefinition(row.id, version);
  const current = currentDefinition(row.id, row.currentVersion);
  if (!old || !current) throw new HttpError(404, "not_found", `Version ${version} isn't here`);
  return saveVersion(ctx, id, restoreDefinition(old, current), restoreNote(version));
}

/** Dry-run validation for the builder's inline errors (includes the area/Finance check). No writes. */
export function validateDraft(userId: string, raw: unknown) {
  const r = validateFor(userId, raw);
  return r.ok ? { ok: true as const, areaFound: r.areaFound, issues: [] } : { ok: false as const, issues: r.issues };
}
