import "server-only";
import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import { config } from "@/server/config";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { createSession as createConversation, getSessionDetail } from "@/server/assistant";
import { requireCap } from "@/server/access";
import type { AssistantBackend } from "@/lib/assistant";
import { localDate } from "@/lib/time";
import {
  applyTemplate,
  areaValidationDefault,
  isClosed,
  isValidationOverdue,
  parseAreaSettings,
  parseGithubUrl,
  safeHref,
  type createItemSchema,
  type ExternalState,
  type GithubRefreshResult,
  type linkSchema,
  type packetSchema,
  type placeSchema,
  type splitSchema,
  type TimelineResponse,
  type TimelineRow,
  type updateItemSchema,
  type validationSchema,
  type ValidationTemplate,
  type validationTemplateSchema,
  type validationUpdateSchema,
  type DependencyRef,
  type TimelineDependency,
  type WorkDetail,
  type WorkEvent,
  type WorkItem,
  type WorkKind,
  type WorkLineage,
  type WorkLink,
  type WorkPacket,
  type WorkStatus,
  type WorkValidation,
  type AreaSettings,
  type LinkedConversationRow,
  type areaSettingsSchema,
} from "@/lib/work";
import type { z } from "zod";
import {
  evaluateValidation,
  LifecycleError,
  nextPacketVersion,
  onImplementationMerged,
  planTransition,
  settleGate,
  wouldCreateCycle,
  wouldCreateDependencyCycle,
} from "./lifecycle";
import { fetchIssueState, fetchPullState, githubRefreshEnabled } from "./github";
import { claimCutoff, dueForRefresh, REFRESH_PARALLELISM } from "./refresh-rules";
import { planPlacement } from "./tree-rules";
import { isUntouched, latestOp, UNDO_LABELS, undoCheck, type UndoKind } from "./undo-rules";
import { AUTO_SETTLE_UNDO_MS, settleDecision, settleSignals } from "./settle-rules";
import { boundedAll } from "@/server/http/fetch";

/**
 * Work hub store (docs/work.md). Every read and write is scoped to the owner:
 * rows of other people are "not found". Status changes always write a
 * work_events row and an audit entry.
 */

const T = schema.workItems;
type ItemRow = typeof T.$inferSelect;
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Db = ReturnType<typeof getDb> | Tx;

const nowIso = () => new Date().toISOString();
const today = () => localDate(Date.now(), config.timezone);

function lifecycle<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LifecycleError) throw new HttpError(409, e.code, e.message);
    throw e;
  }
}

export function toItem(r: ItemRow): WorkItem {
  return {
    id: r.id,
    parentId: r.parentId,
    kind: r.kind as WorkKind,
    title: r.title,
    summary: r.summary,
    nextAction: r.nextAction,
    status: r.status as WorkStatus,
    sortOrder: r.sortOrder,
    startDate: r.startDate,
    targetDate: r.targetDate,
    completedAt: r.completedAt,
    settledKind: (r.settledKind as WorkItem["settledKind"]) ?? null,
    settledReason: r.settledReason,
    archived: r.archived,
    builtIn: !!r.systemKey,
    validationDefault: r.validationDefault === "required" || r.validationDefault === "optional" ? r.validationDefault : null,
    sessionId: r.sessionId ?? null,
    settings: r.parentId === null && r.kind === "area" ? parseAreaSettings(r.settings) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
const toLink = (r: typeof schema.workLinks.$inferSelect): WorkLink => ({
  ...r,
  kind: r.kind as WorkLink["kind"],
  role: r.role as WorkLink["role"],
  externalState: r.externalState as ExternalState | null,
  checksState: r.checksState === "success" || r.checksState === "failure" || r.checksState === "pending" ? r.checksState : null,
  lineage: r.lineage === "handoff_from" ? "handoff_from" : null,
});
const toPacket = (r: typeof schema.workPackets.$inferSelect): WorkPacket => ({ ...r });
const toValidation = (r: typeof schema.workValidations.$inferSelect): WorkValidation => ({
  id: r.id,
  itemId: r.itemId,
  metric: r.metric,
  comparator: r.comparator as WorkValidation["comparator"],
  threshold: r.threshold,
  unit: r.unit,
  baseline: r.baseline,
  observed: r.observed,
  evidenceUrl: r.evidenceUrl,
  notes: r.notes,
  status: r.status as WorkValidation["status"],
  waiverReason: r.waiverReason,
  dueDate: r.dueDate,
  recordedAt: r.recordedAt,
  overdue: isValidationOverdue(r, today()),
});

function event(
  db: Db,
  itemId: string,
  actor: string,
  e: { kind: string; from?: string | null; to?: string | null; reason?: string | null; source?: "manual" | "github" | null },
) {
  db.insert(schema.workEvents)
    .values({
      id: newId(),
      itemId,
      actor,
      kind: e.kind,
      fromStatus: e.from ?? null,
      toStatus: e.to ?? null,
      reason: e.reason ?? null,
      source: e.source ?? null,
      at: nowIso(),
    })
    .run();
}

function lineage(db: Db, userId: string, l: Omit<typeof schema.workLineage.$inferInsert, "id" | "userId">) {
  db.insert(schema.workLineage)
    .values({ id: newId(), userId, ...l })
    .run();
}

/** Filled in by structural mutations so routes can offer Undo (server/work/undo-rules.ts). */
export type OpOut = { op?: { id: string; kind: UndoKind; label: string } };

function recordOp(db: Db, userId: string, itemId: string, kind: UndoKind, payload: Record<string, unknown>, out?: OpOut) {
  const id = newId("op");
  db.insert(schema.workOps)
    .values({ id, userId, itemId, kind, payload: JSON.stringify(payload), createdAt: nowIso() })
    .run();
  if (out) out.op = { id, kind, label: UNDO_LABELS[kind] };
  return id;
}

/** Unarchived children of `parentId` in tree order (what reorder and undo work on). */
function siblingOrder(rows: ItemRow[], parentId: string | null) {
  return rows
    .filter((r) => r.parentId === parentId && !r.archived)
    .sort(byOrder)
    .map((r) => r.id);
}

/** Dependencies touching an item (either side). */
function dependencyCount(db: Db, itemId: string) {
  const D = schema.workDependencies;
  return db
    .select({ id: D.id })
    .from(D)
    .where(or(eq(D.itemId, itemId), eq(D.dependsOnId, itemId)))
    .all().length;
}

function dependencyRefs(userId: string, itemId: string, db: Db, byId: Map<string, ItemRow>) {
  const D = schema.workDependencies;
  const rows = db.select().from(D).where(eq(D.userId, userId)).all();
  const ref = (depId: string, otherId: string): DependencyRef | null => {
    const o = byId.get(otherId);
    return o ? { dependencyId: depId, id: o.id, title: o.title, status: o.status as WorkStatus, open: !isClosed(o.status) } : null;
  };
  return {
    blockedBy: rows
      .filter((r) => r.itemId === itemId)
      .map((r) => ref(r.id, r.dependsOnId))
      .filter((x): x is DependencyRef => !!x),
    blocking: rows
      .filter((r) => r.dependsOnId === itemId)
      .map((r) => ref(r.id, r.itemId))
      .filter((x): x is DependencyRef => !!x),
  };
}

/** The built-in Miscellaneous area, created on first use. */
export function ensureMiscellaneous(userId: string, db: Db = getDb()): ItemRow {
  const found = db
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), eq(T.systemKey, "misc")))
    .get();
  if (found) return found;
  db.insert(T)
    .values({
      id: newId("wk"),
      userId,
      kind: "area",
      title: "Miscellaneous",
      summary: "Work that doesn't belong anywhere yet.",
      systemKey: "misc",
      sortOrder: 1_000_000,
    })
    .onConflictDoNothing()
    .run();
  return db
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), eq(T.systemKey, "misc")))
    .get()!;
}

function ownedItem(userId: string, id: string, db: Db = getDb()): ItemRow {
  const r = db
    .select()
    .from(T)
    .where(and(eq(T.id, id), eq(T.userId, userId)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "Work item not found");
  return r;
}

function ownedLink(userId: string, linkId: string, db: Db = getDb()) {
  const r = db
    .select({ link: schema.workLinks, item: T })
    .from(schema.workLinks)
    .innerJoin(T, eq(T.id, schema.workLinks.itemId))
    .where(and(eq(schema.workLinks.id, linkId), eq(T.userId, userId)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "Link not found");
  return r;
}

function ownedValidation(userId: string, vid: string, db: Db = getDb()) {
  const r = db
    .select({ v: schema.workValidations, item: T })
    .from(schema.workValidations)
    .innerJoin(T, eq(T.id, schema.workValidations.itemId))
    .where(and(eq(schema.workValidations.id, vid), eq(T.userId, userId)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "Validation not found");
  return r;
}

function allRows(userId: string, db: Db = getDb()) {
  return db.select().from(T).where(eq(T.userId, userId)).all();
}

const byOrder = (a: ItemRow | WorkItem, b: ItemRow | WorkItem) =>
  a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function listItems(userId: string, opts: { includeArchived?: boolean } = {}): WorkItem[] {
  ensureMiscellaneous(userId);
  const rows = allRows(userId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Archiving hides the whole branch unless archived items are requested.
  const hidden = (r: ItemRow) => {
    for (let c: ItemRow | undefined = r, n = 0; c && n < 100; c = c.parentId ? byId.get(c.parentId) : undefined, n++) if (c.archived) return true;
    return false;
  };
  return rows
    .filter((r) => opts.includeArchived || !hidden(r))
    .sort(byOrder)
    .map(toItem);
}

function latestPacket(itemId: string, db: Db = getDb()) {
  return db.select().from(schema.workPackets).where(eq(schema.workPackets.itemId, itemId)).orderBy(desc(schema.workPackets.version)).get() ?? null;
}
function validationsOf(itemId: string, db: Db = getDb()) {
  return db.select().from(schema.workValidations).where(eq(schema.workValidations.itemId, itemId)).orderBy(asc(schema.workValidations.createdAt)).all();
}

/** The top-level area an item lives under (itself for an area). */
function areaOf(row: ItemRow, byId: Map<string, ItemRow>): ItemRow | null {
  let cur: ItemRow | undefined = row;
  for (let n = 0; cur && cur.parentId && n < 100; n++) cur = byId.get(cur.parentId);
  return cur && !cur.parentId ? cur : null;
}

function validationDefaultFor(row: ItemRow, byId: Map<string, ItemRow>): WorkDetail["validationDefault"] {
  const area = areaOf(row, byId);
  return {
    value: areaValidationDefault(area),
    explicit: area?.validationDefault === "required" || area?.validationDefault === "optional",
    areaId: area?.id ?? null,
    areaTitle: area?.title ?? null,
  };
}

export function getDetail(userId: string, id: string): WorkDetail {
  const db = getDb();
  const row = ownedItem(userId, id, db);
  const rows = allRows(userId, db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const breadcrumb: { id: string; title: string }[] = [];
  for (let p = row.parentId ? byId.get(row.parentId) : undefined; p && breadcrumb.length < 50; p = p.parentId ? byId.get(p.parentId) : undefined)
    breadcrumb.unshift({ id: p.id, title: p.title });
  const packets = db.select().from(schema.workPackets).where(eq(schema.workPackets.itemId, id)).orderBy(desc(schema.workPackets.version)).all();
  const validations = validationsOf(id, db);
  const lin = db
    .select()
    .from(schema.workLineage)
    .where(eq(schema.workLineage.userId, userId))
    .all()
    .filter((l) => l.childId === id || l.parentId === id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    item: toItem(row),
    breadcrumb,
    children: rows
      .filter((r) => r.parentId === id)
      .sort(byOrder)
      .map(toItem),
    links: db.select().from(schema.workLinks).where(eq(schema.workLinks.itemId, id)).orderBy(asc(schema.workLinks.createdAt)).all().map(toLink),
    packets: packets.map(toPacket),
    validations: validations.map(toValidation),
    events: db.select().from(schema.workEvents).where(eq(schema.workEvents.itemId, id)).orderBy(desc(schema.workEvents.at)).limit(200).all() as WorkEvent[],
    lineage: lin.map((l) => ({
      ...(l as WorkLineage),
      childTitle: byId.get(l.childId)?.title ?? null,
      parentTitle: l.parentId ? (byId.get(l.parentId)?.title ?? null) : null,
    })),
    settle: settleGate(packets[0] ?? null, validations as { status: WorkValidation["status"] }[]),
    validationDefault: validationDefaultFor(row, byId),
    area: (() => {
      const a = areaOf(row, byId);
      return a ? { id: a.id, title: a.title, builtIn: !!a.systemKey, settings: parseAreaSettings(a.settings) } : null;
    })(),
    githubRefresh: githubRefreshEnabled(),
    ...dependencyRefs(userId, id, db, byId),
  };
}

function nextSort(userId: string, parentId: string | null, db: Db) {
  return (
    db
      .select()
      .from(T)
      .where(eq(T.userId, userId))
      .all()
      .filter((r) => r.parentId === parentId && !r.systemKey)
      .reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1
  );
}

function insertItem(
  db: Db,
  userId: string,
  v: {
    parentId: string | null;
    kind: WorkKind;
    title: string;
    summary?: string;
    nextAction?: string;
    startDate?: string | null;
    targetDate?: string | null;
    sessionId?: string | null;
    status?: WorkStatus;
  },
) {
  const id = newId("wk");
  const at = nowIso();
  db.insert(T)
    .values({
      id,
      userId,
      parentId: v.parentId,
      kind: v.kind,
      title: v.title,
      sessionId: v.sessionId ?? null,
      ...(v.status ? { status: v.status } : {}),
      summary: v.summary ?? "",
      nextAction: v.nextAction ?? "",
      startDate: v.startDate ?? null,
      targetDate: v.targetDate ?? null,
      sortOrder: nextSort(userId, v.parentId, db),
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return id;
}

function checkDates(start: string | null | undefined, target: string | null | undefined) {
  if (start && target && target < start) throw new HttpError(400, "dates", "Target date is before the start date");
}

export function createItem(user: CurrentUser, body: z.infer<typeof createItemSchema>, correlationId: string): WorkItem {
  checkDates(body.startDate, body.targetDate);
  const id = getDb().transaction((tx) => {
    let parentId = body.parentId ?? null;
    if (parentId) ownedItem(user.id, parentId, tx);
    // Only areas live at the top; anything else without a home goes to Miscellaneous.
    else if (body.kind !== "area") parentId = ensureMiscellaneous(user.id, tx).id;
    const id = insertItem(tx, user.id, { ...body, parentId });
    event(tx, id, user.id, { kind: "created", to: "captured" });
    return id;
  });
  audit({ actor: user.id, action: "work.create", source: "work", sourceRecord: id, result: "ok", correlationId, detail: { kind: body.kind } });
  return toItem(ownedItem(user.id, id));
}

export function updateItem(user: CurrentUser, id: string, body: z.infer<typeof updateItemSchema>, correlationId: string, out?: OpOut): WorkItem {
  const { status, reason, settings, ...fields } = body;
  const result = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    if (row.systemKey && (fields.archived || (fields.kind && fields.kind !== "area"))) throw new HttpError(409, "built_in", "Miscellaneous is built in");
    if (fields.validationDefault !== undefined && row.parentId !== null)
      throw new HttpError(400, "not_area", "The validation default is an area setting; change it on the area");
    if (settings !== undefined && (row.parentId !== null || row.kind !== "area"))
      throw new HttpError(400, "not_area", "Agent and settle settings belong to an area; change them on the area");
    if (fields.kind && row.kind === "conversation")
      throw new HttpError(409, "conversation_kind", "A conversation stays a conversation; split it into a thread instead");
    if (fields.kind === "area" && row.parentId !== null) throw new HttpError(400, "area_top", "Only top-level items can be areas");
    checkDates(fields.startDate === undefined ? row.startDate : fields.startDate, fields.targetDate === undefined ? row.targetDate : fields.targetDate);
    const nextAction = fields.nextAction ?? row.nextAction;
    if ((row.status === "ready" || row.status === "in_progress") && !status && !nextAction.trim())
      throw new HttpError(409, "next_action_required", "Ready and in-progress work needs a next action");
    const patch: Partial<typeof T.$inferInsert> = { ...fields, updatedAt: nowIso() };
    let transition: { from: string; to: string } | null = null;
    if (status && status !== row.status) {
      const plan = lifecycle(() =>
        planTransition({
          from: row.status as WorkStatus,
          to: status,
          nextAction,
          latestPacket: latestPacket(id, tx),
          validations: validationsOf(id, tx) as { status: WorkValidation["status"] }[],
          reason,
          at: nowIso(),
        }),
      );
      Object.assign(patch, plan);
      transition = { from: row.status, to: status };
      event(tx, id, user.id, { kind: "status", from: row.status, to: status, reason });
    }
    const start = fields.startDate === undefined ? row.startDate : fields.startDate;
    const target = fields.targetDate === undefined ? row.targetDate : fields.targetDate;
    if (start !== row.startDate || target !== row.targetDate)
      event(tx, id, user.id, {
        kind: "dates",
        reason: `Dates: start ${row.startDate ?? "—"} → ${start ?? "—"}, target ${row.targetDate ?? "—"} → ${target ?? "—"}`,
      });
    if (fields.validationDefault !== undefined && fields.validationDefault !== row.validationDefault)
      event(tx, id, user.id, {
        kind: "edit",
        reason: `Validation default: ${fields.validationDefault ?? `by rule (${areaValidationDefault({ ...row, validationDefault: null })})`}`,
      });
    if (fields.archived !== undefined && fields.archived !== row.archived) {
      event(tx, id, user.id, { kind: fields.archived ? "archived" : "unarchived" });
      recordOp(tx, user.id, id, fields.archived ? "archive" : "unarchive", { archived: row.archived }, out);
    }
    if (settings !== undefined) {
      const merged = mergeAreaSettings(parseAreaSettings(row.settings), settings);
      patch.settings = JSON.stringify(merged);
      event(tx, id, user.id, { kind: "edit", reason: `Area settings: ${Object.keys(settings).join(", ") || "unchanged"}` });
    }
    tx.update(T).set(patch).where(eq(T.id, id)).run();
    return transition;
  });
  if (result)
    audit({
      actor: user.id,
      action: "work.status",
      source: "work",
      sourceRecord: id,
      result: "ok",
      correlationId,
      detail: { ...result, reason: reason ?? null },
    });
  else if (fields.archived !== undefined)
    audit({ actor: user.id, action: fields.archived ? "work.archive" : "work.unarchive", source: "work", sourceRecord: id, result: "ok", correlationId });
  if (settings !== undefined)
    audit({
      actor: user.id,
      action: "work.area_settings",
      source: "work",
      sourceRecord: id,
      result: "ok",
      correlationId,
      detail: { fields: Object.keys(settings) },
    });
  return toItem(ownedItem(user.id, id));
}

/** Stored settings + a partial update (validated by areaSettingsSchema). */
export function mergeAreaSettings(current: AreaSettings, patch: z.infer<typeof areaSettingsSchema>): AreaSettings {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  return next;
}

export function moveItem(user: CurrentUser, id: string, parentId: string | null, correlationId: string, out?: OpOut): WorkItem {
  getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    if (row.systemKey) throw new HttpError(409, "built_in", "Miscellaneous is built in");
    if (parentId === row.parentId) return;
    if (parentId === null && row.kind !== "area") throw new HttpError(400, "top_level", "Only areas can sit at the top level");
    if (parentId) ownedItem(user.id, parentId, tx);
    const rows = allRows(user.id, tx);
    const parents = new Map(rows.map((r) => [r.id, r.parentId]));
    if (wouldCreateCycle(parents, id, parentId)) throw new HttpError(409, "cycle", "Can't move an item inside itself");
    recordOp(tx, user.id, id, "move", { fromParentId: row.parentId, toParentId: parentId, prevOrder: siblingOrder(rows, row.parentId) }, out);
    tx.update(T)
      .set({ parentId, sortOrder: nextSort(user.id, parentId, tx), updatedAt: nowIso() })
      .where(eq(T.id, id))
      .run();
    lineage(tx, user.id, { childId: id, parentId: row.parentId, relation: "moved_from", fromParentId: row.parentId, toParentId: parentId, actor: user.id });
    event(tx, id, user.id, { kind: "moved" });
  });
  audit({ actor: user.id, action: "work.move", source: "work", sourceRecord: id, result: "ok", correlationId, detail: { to: parentId } });
  return toItem(ownedItem(user.id, id));
}

/**
 * Drag-and-drop: put an item at `index` among the (unarchived) children of
 * `parentId`. Re-parenting is cycle-safe and records `moved_from` like Move.
 */
export function placeItem(user: CurrentUser, id: string, body: z.infer<typeof placeSchema>, correlationId: string, out?: OpOut): WorkItem {
  const { parentId, index } = body;
  const moved = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    if (row.systemKey) throw new HttpError(409, "built_in", "Miscellaneous is built in");
    if (parentId === null && row.kind !== "area") throw new HttpError(400, "top_level", "Only areas can sit at the top level");
    if (parentId) ownedItem(user.id, parentId, tx);
    const rows = allRows(user.id, tx);
    const parents = new Map(rows.map((r) => [r.id, r.parentId]));
    if (wouldCreateCycle(parents, id, parentId)) throw new HttpError(409, "cycle", "Can't move an item inside itself");
    const siblings = rows.filter((r) => r.parentId === parentId && !r.archived && r.id !== id).sort(byOrder);
    const order = planPlacement(
      siblings.map((r) => ({ id: r.id, builtIn: !!r.systemKey })),
      id,
      index,
    );
    const moved = parentId !== row.parentId;
    recordOp(
      tx,
      user.id,
      id,
      moved ? "move" : "reorder",
      { fromParentId: row.parentId, toParentId: parentId, prevOrder: siblingOrder(rows, row.parentId) },
      out,
    );
    if (moved) {
      tx.update(T).set({ parentId, updatedAt: nowIso() }).where(eq(T.id, id)).run();
      lineage(tx, user.id, { childId: id, parentId: row.parentId, relation: "moved_from", fromParentId: row.parentId, toParentId: parentId, actor: user.id });
      event(tx, id, user.id, { kind: "moved" });
    }
    order.forEach((sid, n) => {
      const r = sid === id ? row : siblings.find((x) => x.id === sid);
      if (r?.systemKey) return; // Miscellaneous stays last among areas
      tx.update(T).set({ sortOrder: n }).where(eq(T.id, sid)).run();
    });
    if (!moved) event(tx, id, user.id, { kind: "reordered" });
    return moved;
  });
  audit({
    actor: user.id,
    action: moved ? "work.move" : "work.reorder",
    source: "work",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { to: parentId, index },
  });
  return toItem(ownedItem(user.id, id));
}

export function reorderItem(user: CurrentUser, id: string, direction: "up" | "down", out?: OpOut): WorkItem[] {
  getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    const siblings = allRows(user.id, tx)
      .filter((r) => r.parentId === row.parentId && !r.archived)
      .sort(byOrder);
    const i = siblings.findIndex((s) => s.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return;
    if (siblings[j]!.systemKey) return; // nothing moves past Miscellaneous
    recordOp(tx, user.id, id, "reorder", { fromParentId: row.parentId, toParentId: row.parentId, prevOrder: siblings.map((x) => x.id) }, out);
    event(tx, id, user.id, { kind: "reordered" });
    [siblings[i], siblings[j]] = [siblings[j]!, siblings[i]!];
    siblings.forEach((s, n) => {
      if (s.systemKey) return; // Miscellaneous stays last among areas
      tx.update(T).set({ sortOrder: n }).where(eq(T.id, s.id)).run();
    });
  });
  return listItems(user.id);
}

export function forkItem(user: CurrentUser, id: string, title: string | undefined, correlationId: string, out?: OpOut): WorkItem {
  const forkId = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    if (row.systemKey || row.parentId === null) throw new HttpError(409, "fork_area", "Areas can't be forked");
    if (row.kind === "conversation")
      throw new HttpError(409, "fork_conversation", "Fork the conversation itself (Fork latest state): the fork lands next to it in the tree");
    const forkId = insertItem(tx, user.id, {
      parentId: row.parentId,
      kind: row.kind as WorkKind,
      title: title?.trim() || `${row.title} (fork)`,
      summary: row.summary,
      nextAction: row.nextAction,
    });
    const sources = tx
      .select()
      .from(schema.workLinks)
      .where(and(eq(schema.workLinks.itemId, id), eq(schema.workLinks.role, "source")))
      .all();
    for (const l of sources)
      tx.insert(schema.workLinks)
        .values({ ...l, id: newId(), itemId: forkId, lineage: null, packetId: null, createdAt: nowIso() })
        .run();
    lineage(tx, user.id, { childId: forkId, parentId: id, relation: "forked_from", actor: user.id });
    event(tx, forkId, user.id, { kind: "created", to: "captured", reason: `Forked from “${row.title}”` });
    recordOp(tx, user.id, forkId, "fork", { sourceId: id, copiedLinks: sources.length }, out);
    return forkId;
  });
  audit({ actor: user.id, action: "work.fork", source: "work", sourceRecord: forkId, result: "ok", correlationId, detail: { from: id } });
  return toItem(ownedItem(user.id, forkId));
}

export function splitItem(user: CurrentUser, id: string, body: z.infer<typeof splitSchema>, correlationId: string, out?: OpOut): WorkItem {
  const childId = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    const childId = insertItem(tx, user.id, {
      parentId: id,
      kind: body.kind ?? (row.kind === "area" ? "project" : "thread"),
      title: body.title,
      summary: body.summary ?? "",
    });
    lineage(tx, user.id, { childId, parentId: id, relation: "split_from", note: body.summary ? body.summary.slice(0, 500) : null, actor: user.id });
    event(tx, childId, user.id, { kind: "created", to: "captured", reason: `Split from “${row.title}”` });
    recordOp(tx, user.id, childId, "split", { sourceId: id, copiedLinks: 0 }, out);
    return childId;
  });
  audit({ actor: user.id, action: "work.split", source: "work", sourceRecord: childId, result: "ok", correlationId, detail: { from: id } });
  return toItem(ownedItem(user.id, childId));
}

function restoreOrder(tx: Db, rows: ItemRow[], parentId: string | null, prevOrder: string[], movingId: string) {
  const current = siblingOrder(rows, parentId).filter((x) => x !== movingId);
  const wanted = prevOrder.filter((x) => x === movingId || current.includes(x));
  const order = [...wanted, ...current.filter((x) => !wanted.includes(x))];
  const byId = new Map(rows.map((r) => [r.id, r]));
  order.forEach((sid, n) => {
    if (byId.get(sid)?.systemKey) return;
    tx.update(T).set({ sortOrder: n }).where(eq(T.id, sid)).run();
  });
}

/**
 * Undo a structural operation. Allowed once, only while it is still the latest
 * structural operation on its item, within the undo window (undo-rules.ts).
 * Split/fork undo deletes the new item only if untouched; otherwise archives it.
 */
export function undoOp(user: CurrentUser, opId: string, correlationId: string, now = new Date()) {
  const result = getDb().transaction((tx) => {
    const op = tx
      .select()
      .from(schema.workOps)
      .where(and(eq(schema.workOps.id, opId), eq(schema.workOps.userId, user.id)))
      .get();
    if (!op) throw new HttpError(404, "not_found", "Nothing to undo");
    const latest = latestOp(
      tx
        .select()
        .from(schema.workOps)
        .where(and(eq(schema.workOps.userId, user.id), eq(schema.workOps.itemId, op.itemId)))
        .all(),
    );
    const check = undoCheck(op, latest?.id ?? null, now, op.kind === "settle" ? AUTO_SETTLE_UNDO_MS : undefined);
    if (!check.ok) throw new HttpError(409, check.code, check.message);
    const payload = JSON.parse(op.payload) as {
      fromParentId?: string | null;
      toParentId?: string | null;
      prevOrder?: string[];
      archived?: boolean;
      copiedLinks?: number;
      fromStatus?: string;
    };
    const row = ownedItem(user.id, op.itemId, tx);
    tx.update(schema.workOps).set({ undoneAt: now.toISOString() }).where(eq(schema.workOps.id, op.id)).run();
    const kind = op.kind as UndoKind;
    let outcome: "restored" | "deleted" | "archived" = "restored";
    if (kind === "move" || kind === "reorder") {
      const from = payload.fromParentId ?? null;
      if (row.parentId !== (payload.toParentId ?? null)) throw new HttpError(409, "superseded", "Something else changed this item since, so undo isn't safe");
      if (from !== row.parentId) {
        if (from) ownedItem(user.id, from, tx);
        const parents = new Map(allRows(user.id, tx).map((r) => [r.id, r.parentId]));
        if (wouldCreateCycle(parents, row.id, from)) throw new HttpError(409, "cycle", "Can't move an item inside itself");
        tx.update(T).set({ parentId: from, updatedAt: nowIso() }).where(eq(T.id, row.id)).run();
        lineage(tx, user.id, {
          childId: row.id,
          parentId: row.parentId,
          relation: "moved_from",
          note: "Undo",
          fromParentId: row.parentId,
          toParentId: from,
          actor: user.id,
        });
      }
      restoreOrder(tx, allRows(user.id, tx), from, payload.prevOrder ?? [], row.id);
      event(tx, row.id, user.id, { kind: "undo", reason: kind === "move" ? "Undid move" : "Undid reorder" });
    } else if (kind === "settle") {
      if (row.status !== "settled") throw new HttpError(409, "superseded", "Something else changed this item since, so undo isn't safe");
      const back = (payload.fromStatus ?? "ready_to_settle") as WorkStatus;
      tx.update(T).set({ status: back, settledKind: null, settledReason: null, completedAt: null, updatedAt: nowIso() }).where(eq(T.id, row.id)).run();
      event(tx, row.id, user.id, { kind: "status", from: "settled", to: back, reason: "Undid automatic settle" });
    } else if (kind === "archive" || kind === "unarchive") {
      tx.update(T).set({ archived: !!payload.archived, updatedAt: nowIso() }).where(eq(T.id, row.id)).run();
      event(tx, row.id, user.id, { kind: "undo", reason: kind === "archive" ? "Undid archive" : "Undid unarchive" });
    } else {
      const count = (table: typeof schema.workPackets | typeof schema.workValidations | typeof schema.workLinks) =>
        tx.select({ id: table.id }).from(table).where(eq(table.itemId, row.id)).all().length;
      const untouched = isUntouched({
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        eventKinds: tx
          .select({ kind: schema.workEvents.kind })
          .from(schema.workEvents)
          .where(eq(schema.workEvents.itemId, row.id))
          .all()
          .map((e) => e.kind),
        children: allRows(user.id, tx).filter((r) => r.parentId === row.id).length,
        packets: count(schema.workPackets),
        validations: count(schema.workValidations),
        links: count(schema.workLinks),
        copiedLinks: payload.copiedLinks ?? 0,
        dependencies: dependencyCount(tx, row.id),
        derived: tx
          .select({ id: schema.workLineage.id })
          .from(schema.workLineage)
          .where(and(eq(schema.workLineage.userId, user.id), eq(schema.workLineage.parentId, row.id)))
          .all().length,
      });
      const source = (payload as { sourceId?: string }).sourceId;
      if (untouched) {
        // Nothing happened to it yet: remove it and the lineage edge its creation wrote.
        tx.delete(schema.workLineage)
          .where(and(eq(schema.workLineage.userId, user.id), eq(schema.workLineage.childId, row.id)))
          .run();
        tx.delete(T).where(eq(T.id, row.id)).run();
        if (source) event(tx, source, user.id, { kind: "undo", reason: `Undid ${kind}: removed “${row.title}”` });
        outcome = "deleted";
      } else {
        tx.update(T).set({ archived: true, updatedAt: nowIso() }).where(eq(T.id, row.id)).run();
        event(tx, row.id, user.id, { kind: "undo", reason: `Undid ${kind}: archived because it had changed since` });
        outcome = "archived";
      }
    }
    return { itemId: row.id, kind, outcome };
  });
  audit({
    actor: user.id,
    action: "work.undo",
    source: "work",
    sourceRecord: result.itemId,
    result: "ok",
    correlationId,
    detail: { op: opId, kind: result.kind, outcome: result.outcome },
  });
  return { ...result, item: result.outcome === "deleted" ? null : toItem(ownedItem(user.id, result.itemId)) };
}

/** "item depends on dependsOn" (blocked-by). Cycle-safe; both items must be yours. */
export function addDependency(user: CurrentUser, itemId: string, dependsOnId: string, correlationId: string): DependencyRef {
  const D = schema.workDependencies;
  const out = getDb().transaction((tx) => {
    ownedItem(user.id, itemId, tx);
    const other = ownedItem(user.id, dependsOnId, tx);
    const edges = tx.select().from(D).where(eq(D.userId, user.id)).all();
    if (edges.some((e) => e.itemId === itemId && e.dependsOnId === dependsOnId)) throw new HttpError(409, "exists", "Already a dependency");
    if (wouldCreateDependencyCycle(edges, itemId, dependsOnId)) throw new HttpError(409, "cycle", "That would make a dependency loop");
    const id = newId();
    tx.insert(D).values({ id, userId: user.id, itemId, dependsOnId, createdAt: nowIso() }).run();
    event(tx, itemId, user.id, { kind: "dependency", reason: `Now depends on “${other.title}”` });
    return { id, other };
  });
  audit({
    actor: user.id,
    action: "work.dependency_add",
    source: "work",
    sourceRecord: itemId,
    result: "ok",
    correlationId,
    detail: { dependsOn: dependsOnId },
  });
  return { dependencyId: out.id, id: out.other.id, title: out.other.title, status: out.other.status as WorkStatus, open: !isClosed(out.other.status) };
}

export function removeDependency(user: CurrentUser, dependencyId: string, correlationId: string) {
  const D = schema.workDependencies;
  const dep = getDb()
    .select()
    .from(D)
    .where(and(eq(D.id, dependencyId), eq(D.userId, user.id)))
    .get();
  if (!dep) throw new HttpError(404, "not_found", "Dependency not found");
  const other = getDb().select({ title: T.title }).from(T).where(eq(T.id, dep.dependsOnId)).get();
  getDb().transaction((tx) => {
    tx.delete(D).where(eq(D.id, dependencyId)).run();
    event(tx, dep.itemId, user.id, { kind: "dependency", reason: `No longer depends on “${other?.title ?? "an item"}”` });
  });
  audit({ actor: user.id, action: "work.dependency_remove", source: "work", sourceRecord: dep.itemId, result: "ok", correlationId });
  return { ok: true };
}

export function createPacket(user: CurrentUser, id: string, body: z.infer<typeof packetSchema>, correlationId: string): WorkPacket {
  const out = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    const existing = tx.select({ version: schema.workPackets.version }).from(schema.workPackets).where(eq(schema.workPackets.itemId, id)).all();
    const version = nextPacketVersion(existing);
    const pid = newId();
    // Omitted → the area's default (Miscellaneous/Home optional, others required, or the area's own setting).
    const vd = validationDefaultFor(row, new Map(allRows(user.id, tx).map((r) => [r.id, r])));
    const validationRequired = body.validationRequired ?? vd.value === "required";
    const noValidationReason = validationRequired
      ? null
      : body.noValidationReason?.trim() || `Validation is optional in ${vd.areaTitle ?? "this area"} (area default)`;
    tx.insert(schema.workPackets)
      .values({
        id: pid,
        itemId: id,
        version,
        objective: body.objective,
        inScope: body.inScope,
        outOfScope: body.outOfScope,
        acceptanceCriteria: body.acceptanceCriteria,
        decisions: body.decisions,
        openQuestions: body.openQuestions,
        context: body.context,
        validationRequired,
        noValidationReason,
        createdBy: user.id,
        createdAt: nowIso(),
      })
      .run();
    event(tx, id, user.id, { kind: "packet", reason: `Work packet v${version}` });
    const patch: Partial<typeof T.$inferInsert> = { nextAction: body.nextAction, updatedAt: nowIso() };
    let transition: { from: string; to: string } | null = null;
    if (row.status !== body.status) {
      Object.assign(
        patch,
        lifecycle(() =>
          planTransition({
            from: row.status as WorkStatus,
            to: body.status,
            nextAction: body.nextAction,
            latestPacket: null,
            validations: [],
            at: nowIso(),
          }),
        ),
      );
      if (!row.startDate && body.status === "in_progress") patch.startDate = today();
      event(tx, id, user.id, { kind: "status", from: row.status, to: body.status, reason: `Started focused work (packet v${version})` });
      transition = { from: row.status, to: body.status };
    }
    tx.update(T).set(patch).where(eq(T.id, id)).run();
    return { pid, version, transition };
  });
  audit({ actor: user.id, action: "work.packet", source: "work", sourceRecord: id, result: "ok", correlationId, detail: { version: out.version } });
  if (out.transition) audit({ actor: user.id, action: "work.status", source: "work", sourceRecord: id, result: "ok", correlationId, detail: out.transition });
  return toPacket(getDb().select().from(schema.workPackets).where(eq(schema.workPackets.id, out.pid)).get()!);
}

function parseSessionRef(input: string) {
  const s = input.trim();
  const m = s.match(/\/chat\/([^/?#]+)/);
  const id = m ? decodeURIComponent(m[1]!) : s;
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new HttpError(400, "session_id", "That isn't a conversation id or /chat link");
  return id;
}

export async function addLink(user: CurrentUser, itemId: string, body: z.infer<typeof linkSchema>, correlationId: string): Promise<WorkLink> {
  ownedItem(user.id, itemId);
  let values: Omit<typeof schema.workLinks.$inferInsert, "id" | "itemId">;
  if (body.kind === "chat_session") {
    const sessionId = parseSessionRef(body.targetId || body.url || "");
    const dup = getDb()
      .select({ id: schema.workLinks.id })
      .from(schema.workLinks)
      .where(and(eq(schema.workLinks.itemId, itemId), eq(schema.workLinks.kind, "chat_session"), eq(schema.workLinks.targetId, sessionId)))
      .get();
    if (dup) throw new HttpError(409, "already_linked", "That conversation is already linked here");
    let title = body.title || "";
    try {
      // Also the access check: you can only link conversations you can open.
      const d = await Promise.race([
        getSessionDetail(user, sessionId),
        new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 6000).unref?.()),
      ]);
      title = title || d.session.title || "Untitled conversation";
    } catch (e) {
      if (e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 400)) throw new HttpError(404, "not_found", "Conversation not found");
      if (e instanceof Error && "kind" in e && (e as { kind: string }).kind === "not_found") throw new HttpError(404, "not_found", "Conversation not found");
      title = title || `Conversation ${sessionId}`;
    }
    values = { kind: "chat_session", targetId: sessionId, url: null, title, role: body.role ?? "source" };
  } else if (body.kind === "github_pr" || body.kind === "github_issue") {
    const ref = parseGithubUrl(body.url ?? "");
    if (!ref || (body.kind === "github_pr") !== (ref.kind === "pull"))
      throw new HttpError(400, "github_url", body.kind === "github_pr" ? "Paste a GitHub pull request URL" : "Paste a GitHub issue URL");
    values = {
      kind: body.kind,
      targetId: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: ref.url,
      title: body.title || `${ref.owner}/${ref.repo}#${ref.number}`,
      role: body.role ?? (body.kind === "github_pr" ? "implementation" : "reference"),
      externalState: "open",
      stateChangedAt: nowIso(),
    };
  } else {
    const href = safeHref(body.url ?? "");
    if (!href || href.startsWith("/")) throw new HttpError(400, "url", "Paste an http(s) URL");
    values = { kind: "url", targetId: null, url: href, title: body.title || new URL(href).hostname, role: body.role ?? "reference" };
  }
  const id = newId();
  getDb().transaction((tx) => {
    tx.insert(schema.workLinks)
      .values({ id, itemId, ...values, createdAt: nowIso() })
      .run();
    event(tx, itemId, user.id, { kind: "link", reason: `Linked ${values.title}` });
  });
  audit({
    actor: user.id,
    action: "work.link",
    source: "work",
    sourceRecord: itemId,
    result: "ok",
    correlationId,
    detail: { kind: values.kind, target: values.targetId },
  });
  return toLink(getDb().select().from(schema.workLinks).where(eq(schema.workLinks.id, id)).get()!);
}

/**
 * "Continue in new conversation": a new Hermes or Claude conversation through
 * the assistant layer, linked as a `source` with `handoff_from` lineage. The
 * handoff is only a draft in the browser; nothing is sent to the assistant here.
 */
export async function continueInConversation(user: CurrentUser, itemId: string, backend: AssistantBackend | undefined, correlationId: string) {
  requireCap(user, "hermes.chat");
  const row = ownedItem(user.id, itemId);
  const packet = latestPacket(itemId);
  const session = await createConversation(user, `Continue: ${row.title}`.slice(0, 200), backend);
  const id = newId();
  const via = packet ? `handoff from packet v${packet.version}` : "handoff, no packet yet";
  getDb().transaction((tx) => {
    tx.insert(schema.workLinks)
      .values({
        id,
        itemId,
        kind: "chat_session",
        targetId: session.id,
        url: null,
        title: session.title || `Continue: ${row.title}`,
        role: "source",
        lineage: "handoff_from",
        packetId: packet?.id ?? null,
        createdAt: nowIso(),
      })
      .run();
    event(tx, itemId, user.id, { kind: "handoff", reason: `Continued in a new conversation (${via})` });
  });
  audit({
    actor: user.id,
    action: "work.handoff",
    source: "work",
    sourceRecord: itemId,
    result: "ok",
    correlationId,
    detail: { session: session.id, packet: packet?.version ?? null },
  });
  return { session: { id: session.id, title: session.title }, link: toLink(getDb().select().from(schema.workLinks).where(eq(schema.workLinks.id, id)).get()!) };
}

/** Apply a PR/issue state change (manual or read back from GitHub), including merge handling. */
export function setLinkState(user: CurrentUser, linkId: string, state: ExternalState, correlationId: string, via: "manual" | "github" = "manual") {
  return applyLinkState(user.id, user.id, linkId, state, correlationId, via);
}

/**
 * setLinkState for a link owned by `ownerId`, acted on by `actor` (the person,
 * or "github" for the poller and webhooks). Idempotent: an unchanged state is
 * a no-op, so a merge transition applies exactly once whoever sees it first.
 */
export function applyLinkState(
  ownerId: string,
  actor: string,
  linkId: string,
  state: ExternalState,
  correlationId: string,
  via: "manual" | "github" = "manual",
) {
  const user = { id: ownerId };
  const outcome = getDb().transaction((tx) => {
    const { link, item } = ownedLink(user.id, linkId, tx);
    if (link.kind !== "github_pr" && link.kind !== "github_issue") throw new HttpError(400, "not_github", "Only GitHub links have a state");
    if (link.externalState === state) return null;
    // A merged PR is final on GitHub: a (possibly stale) readback never un-merges it.
    if (via === "github" && link.kind === "github_pr" && link.externalState === "merged") return null;
    tx.update(schema.workLinks).set({ externalState: state, stateChangedAt: nowIso() }).where(eq(schema.workLinks.id, linkId)).run();
    const number = Number(link.targetId?.split("#")[1]) || null;
    const label = `${link.kind === "github_pr" ? "PR" : "Issue"} #${number ?? "?"}`;
    event(tx, item.id, actor, {
      kind: state === "merged" ? "merged" : state === "closed" ? "closed" : "link",
      reason: `${label} ${state}${via === "github" ? " (read from GitHub)" : ""}`,
      source: via,
    });
    if (!(state === "merged" && link.kind === "github_pr" && link.role === "implementation")) return { itemId: item.id, transition: null };
    const plan = onImplementationMerged({
      status: item.status as WorkStatus,
      latestPacket: latestPacket(item.id, tx),
      validations: validationsOf(item.id, tx) as { status: WorkValidation["status"] }[],
      prNumber: number,
      at: nowIso(),
    });
    if (!plan) return { itemId: item.id, transition: null };
    const { reason, ...patch } = plan;
    tx.update(T)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(T.id, item.id))
      .run();
    event(tx, item.id, actor, { kind: "status", from: item.status, to: plan.status, reason, source: via });
    return { itemId: item.id, transition: { from: item.status, to: plan.status, reason } };
  });
  if (outcome) audit({ actor, action: "work.link_state", source: "work", sourceRecord: linkId, result: "ok", correlationId, detail: { state, via } });
  if (outcome?.transition)
    audit({ actor, action: "work.status", source: "work", sourceRecord: outcome.itemId, result: "ok", correlationId, detail: outcome.transition });
  return toLink(ownedLink(user.id, linkId).link);
}

export function removeLink(user: CurrentUser, linkId: string, correlationId: string) {
  const { link, item } = ownedLink(user.id, linkId);
  getDb().transaction((tx) => {
    tx.delete(schema.workLinks).where(eq(schema.workLinks.id, linkId)).run();
    event(tx, item.id, user.id, { kind: "link", reason: `Removed link ${link.title}` });
  });
  audit({ actor: user.id, action: "work.unlink", source: "work", sourceRecord: item.id, result: "ok", correlationId, detail: { kind: link.kind } });
  return { ok: true };
}

/** Read one PR/issue from GitHub (read-only) and apply it through the merge rules. */
export async function readBack(owner: { id: string }, link: typeof schema.workLinks.$inferSelect, correlationId: string, actor = owner.id) {
  const ref = parseGithubUrl(link.url ?? "");
  if (!ref) throw new HttpError(400, "github_url", "Not a GitHub link");
  try {
    const remote = link.kind === "github_pr" ? await fetchPullState(ref) : await fetchIssueState(ref);
    const db = getDb();
    const patch: Partial<typeof schema.workLinks.$inferInsert> = { checkedAt: nowIso(), checkError: null };
    if (remote.title && link.title === `${ref.owner}/${ref.repo}#${ref.number}`) patch.title = `${remote.title} (#${ref.number})`;
    // The current head's result (possibly none yet) always replaces an earlier commit's badge.
    if ("checks" in remote) Object.assign(patch, { checksState: remote.checks ?? null, checksAt: nowIso() });
    db.update(schema.workLinks).set(patch).where(eq(schema.workLinks.id, link.id)).run();
    // Changed meanwhile (a webhook or a manual mark landed while we were reading)? Keep the newer state.
    const now = db.select({ s: schema.workLinks.externalState }).from(schema.workLinks).where(eq(schema.workLinks.id, link.id)).get();
    if (now && now.s !== link.externalState) return toLink(db.select().from(schema.workLinks).where(eq(schema.workLinks.id, link.id)).get()!);
    return applyLinkState(owner.id, actor, link.id, remote.state, correlationId, "github");
  } catch (e) {
    getDb()
      .update(schema.workLinks)
      .set({ checkedAt: nowIso(), checkError: (e as Error).message.slice(0, 300) })
      .where(eq(schema.workLinks.id, link.id))
      .run();
    throw e;
  }
}

/** Read-only GitHub readback of one link (the Refresh button); the token never leaves the server. */
export async function refreshLink(user: CurrentUser, linkId: string, correlationId: string) {
  const { link } = ownedLink(user.id, linkId);
  if ((link.kind !== "github_pr" && link.kind !== "github_issue") || !link.url)
    throw new HttpError(400, "not_github", "Only GitHub pull requests and issues can be refreshed");
  if (!githubRefreshEnabled()) throw new HttpError(409, "github_not_configured", "Add a GitHub connection (Settings → Connections) to refresh from GitHub");
  return readBack(user, link, correlationId);
}

/**
 * Automatic refresh on item view and dashboard load (only with JARVIS_GITHUB_TOKEN).
 * Throttled per link (server/work/refresh-rules.ts): each due link is claimed
 * with a conditional update first, so concurrent requests never read the same
 * link twice; then at most 4 GitHub reads run at once. Results go through
 * setLinkState, which ignores unchanged states, so a merge applies exactly once.
 */
export async function autoRefreshLinks(user: CurrentUser, scope: { itemId?: string }, correlationId: string, now = new Date()): Promise<GithubRefreshResult> {
  if (!githubRefreshEnabled()) return { enabled: false, checked: 0, changed: 0, errors: 0 };
  if (scope.itemId) ownedItem(user.id, scope.itemId);
  const db = getDb();
  const L = schema.workLinks;
  const links = db
    .select({ link: L })
    .from(L)
    .innerJoin(T, eq(T.id, L.itemId))
    .where(and(eq(T.userId, user.id), inArray(L.kind, ["github_pr", "github_issue"]), ...(scope.itemId ? [eq(L.itemId, scope.itemId)] : [])))
    .all()
    .map((r) => r.link);
  const due = dueForRefresh(links, now);
  const cutoff = claimCutoff(now);
  const claimed = due.filter(
    (id) =>
      db
        .update(L)
        .set({ checkedAt: now.toISOString() })
        .where(and(eq(L.id, id), or(isNull(L.checkedAt), lt(L.checkedAt, cutoff))))
        .run().changes === 1,
  );
  const byId = new Map(links.map((l) => [l.id, l]));
  const results = await boundedAll(
    claimed.map((id) => async () => {
      const before = byId.get(id)!;
      const after = await readBack(user, before, correlationId);
      return after.externalState !== before.externalState;
    }),
    REFRESH_PARALLELISM,
  );
  return {
    enabled: true,
    checked: claimed.length,
    changed: results.filter((r) => r.status === "fulfilled" && r.value).length,
    errors: results.filter((r) => r.status === "rejected").length,
  };
}

export function addValidation(user: CurrentUser, itemId: string, body: z.infer<typeof validationSchema>, correlationId: string): WorkValidation {
  ownedItem(user.id, itemId);
  const id = newId();
  getDb().transaction((tx) => {
    tx.insert(schema.workValidations)
      .values({
        id,
        itemId,
        metric: body.metric,
        comparator: body.comparator,
        threshold: body.threshold,
        unit: body.unit,
        baseline: body.baseline ?? null,
        dueDate: body.dueDate ?? null,
      })
      .run();
    event(tx, itemId, user.id, {
      kind: "validation",
      reason: `Validation added: ${body.metric} ${body.comparator} ${body.threshold}${body.unit ? ` ${body.unit}` : ""}`,
    });
  });
  audit({ actor: user.id, action: "work.validation_add", source: "work", sourceRecord: itemId, result: "ok", correlationId });
  return toValidation(getDb().select().from(schema.workValidations).where(eq(schema.workValidations.id, id)).get()!);
}

// --- validation templates (per person; nothing is seeded) ---

const VT = schema.workValidationTemplates;
const toTemplate = (r: typeof VT.$inferSelect): ValidationTemplate => ({
  id: r.id,
  name: r.name,
  metric: r.metric,
  comparator: r.comparator as ValidationTemplate["comparator"],
  threshold: r.threshold,
  unit: r.unit,
  dueOffsetDays: r.dueOffsetDays,
  createdAt: r.createdAt,
});

export function listTemplates(userId: string): ValidationTemplate[] {
  return getDb().select().from(VT).where(eq(VT.userId, userId)).orderBy(asc(VT.name), asc(VT.createdAt)).all().map(toTemplate);
}

export function createTemplate(user: CurrentUser, body: z.infer<typeof validationTemplateSchema>, correlationId: string): ValidationTemplate {
  const count = getDb().select({ id: VT.id }).from(VT).where(eq(VT.userId, user.id)).all().length;
  if (count >= 100) throw new HttpError(409, "too_many", "Up to 100 validation templates");
  const id = newId();
  getDb()
    .insert(VT)
    .values({
      id,
      userId: user.id,
      name: body.name?.trim() || body.metric,
      metric: body.metric,
      comparator: body.comparator,
      threshold: body.threshold,
      unit: body.unit,
      dueOffsetDays: body.dueOffsetDays ?? null,
      createdAt: nowIso(),
    })
    .run();
  audit({ actor: user.id, action: "work.template_add", source: "work", sourceRecord: id, result: "ok", correlationId });
  return toTemplate(getDb().select().from(VT).where(eq(VT.id, id)).get()!);
}

export function deleteTemplate(user: CurrentUser, templateId: string, correlationId: string) {
  const r = getDb()
    .delete(VT)
    .where(and(eq(VT.id, templateId), eq(VT.userId, user.id)))
    .run();
  if (!r.changes) throw new HttpError(404, "not_found", "Template not found");
  audit({ actor: user.id, action: "work.template_remove", source: "work", sourceRecord: templateId, result: "ok", correlationId });
  return { ok: true };
}

/** "Add from template": a new pending validation with the template's contract and due offset. */
export function addValidationFromTemplate(user: CurrentUser, itemId: string, templateId: string, correlationId: string): WorkValidation {
  const t = getDb()
    .select()
    .from(VT)
    .where(and(eq(VT.id, templateId), eq(VT.userId, user.id)))
    .get();
  if (!t) throw new HttpError(404, "not_found", "Template not found");
  return addValidation(user, itemId, applyTemplate(toTemplate(t), today()), correlationId);
}

export function updateValidation(user: CurrentUser, vid: string, body: z.infer<typeof validationUpdateSchema>, correlationId: string): WorkValidation {
  const out = getDb().transaction((tx) => {
    const { v, item } = ownedValidation(user.id, vid, tx);
    const merged = {
      metric: body.metric ?? v.metric,
      comparator: (body.comparator ?? v.comparator) as WorkValidation["comparator"],
      threshold: body.threshold ?? v.threshold,
      unit: body.unit ?? v.unit,
      baseline: body.baseline === undefined ? v.baseline : body.baseline,
      dueDate: body.dueDate === undefined ? v.dueDate : body.dueDate,
      observed: body.observed === undefined ? v.observed : body.observed,
      evidenceUrl: body.evidenceUrl === undefined ? v.evidenceUrl : body.evidenceUrl ? safeHref(body.evidenceUrl) : null,
      notes: body.notes === undefined ? v.notes : body.notes,
    };
    if (body.evidenceUrl && !merged.evidenceUrl) throw new HttpError(400, "url", "Evidence links must be http(s)");
    const result = lifecycle(() =>
      evaluateValidation({
        comparator: merged.comparator,
        threshold: merged.threshold,
        observed: merged.observed,
        waive: body.waive,
        waiverReason: body.waiverReason,
      }),
    );
    const recorded = body.observed !== undefined || body.waive;
    tx.update(schema.workValidations)
      .set({ ...merged, ...result, recordedAt: recorded ? nowIso() : v.recordedAt })
      .where(eq(schema.workValidations.id, vid))
      .run();
    if (recorded || result.status !== v.status)
      event(tx, item.id, user.id, {
        kind: "validation",
        reason:
          result.status === "waived"
            ? `${merged.metric} waived: ${result.waiverReason}`
            : `${merged.metric}: observed ${merged.observed ?? "—"}${merged.unit ? ` ${merged.unit}` : ""} → ${result.status}`,
      });
    return { itemId: item.id, status: result.status };
  });
  audit({
    actor: user.id,
    action: "work.validation_record",
    source: "work",
    sourceRecord: out.itemId,
    result: "ok",
    correlationId,
    detail: { validation: vid, status: out.status },
  });
  return toValidation(ownedValidation(user.id, vid).v);
}

export function deleteValidation(user: CurrentUser, vid: string, correlationId: string) {
  const { v, item } = ownedValidation(user.id, vid);
  getDb().transaction((tx) => {
    tx.delete(schema.workValidations).where(eq(schema.workValidations.id, vid)).run();
    event(tx, item.id, user.id, { kind: "validation", reason: `Validation removed: ${v.metric}` });
  });
  audit({ actor: user.id, action: "work.validation_remove", source: "work", sourceRecord: item.id, result: "ok", correlationId });
  return { ok: true };
}

export function settleItem(user: CurrentUser, id: string, reason: string | undefined, correlationId: string) {
  return updateItem(user, id, { status: "settled", reason }, correlationId);
}

/** Reopen (always allowed on settled work); optionally create a linked follow-up child. */
export function reopenItem(user: CurrentUser, id: string, body: { reason: string; followUpTitle?: string }, correlationId: string) {
  const row = ownedItem(user.id, id);
  if (row.status === "reopened") throw new HttpError(409, "already_reopened", "Already reopened");
  const item = updateItem(user, id, { status: "reopened", reason: body.reason }, correlationId);
  let followUp: WorkItem | null = null;
  if (body.followUpTitle?.trim()) {
    const childId = getDb().transaction((tx) => {
      const childId = insertItem(tx, user.id, { parentId: id, kind: "thread", title: body.followUpTitle!.trim(), summary: `Follow-up: ${body.reason}` });
      lineage(tx, user.id, { childId, parentId: id, relation: "handoff_from", note: body.reason, actor: user.id });
      event(tx, childId, user.id, { kind: "created", to: "captured", reason: `Follow-up after reopening “${row.title}”` });
      return childId;
    });
    audit({ actor: user.id, action: "work.create", source: "work", sourceRecord: childId, result: "ok", correlationId, detail: { followUpOf: id } });
    followUp = toItem(ownedItem(user.id, childId));
  }
  return { item, followUp };
}

// --- read models: timeline, dashboard, search ---

/** Depth-first subtree of `rootId` (or every area), skipping archived items. */
export function subtree(userId: string, rootId: string | null) {
  const rows = allRows(userId).filter((r) => !r.archived);
  const kids = new Map<string | null, ItemRow[]>();
  for (const r of rows) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
  for (const list of kids.values()) list.sort(byOrder);
  const out: { row: ItemRow; depth: number }[] = [];
  const walk = (r: ItemRow, depth: number) => {
    if (out.length > 2000 || depth > 40) return;
    out.push({ row: r, depth });
    for (const c of kids.get(r.id) ?? []) walk(c, depth + 1);
  };
  if (rootId) {
    const root = rows.find((r) => r.id === rootId);
    if (!root) throw new HttpError(404, "not_found", "Work item not found");
    walk(root, 0);
  } else for (const r of kids.get(null) ?? []) walk(r, 0);
  return out;
}

export function timeline(userId: string, rootId: string | null): TimelineResponse {
  ensureMiscellaneous(userId);
  const tree = subtree(userId, rootId);
  const ids = tree.map((t) => t.row.id);
  const db = getDb();
  const events = ids.length ? db.select().from(schema.workEvents).where(inArray(schema.workEvents.itemId, ids)).orderBy(asc(schema.workEvents.at)).all() : [];
  const vals = ids.length ? db.select().from(schema.workValidations).where(inArray(schema.workValidations.itemId, ids)).all() : [];
  const t = today();
  const all = new Map(allRows(userId, db).map((r) => [r.id, r]));
  const deps = db.select().from(schema.workDependencies).where(eq(schema.workDependencies.userId, userId)).all();
  const inView = new Set(ids);
  const blocked = new Set(deps.filter((d) => all.has(d.dependsOnId) && !isClosed(all.get(d.dependsOnId)!.status)).map((d) => d.itemId));
  const dependencies: TimelineDependency[] = deps
    .filter((d) => inView.has(d.itemId) && inView.has(d.dependsOnId))
    .map((d) => ({ id: d.id, from: d.dependsOnId, to: d.itemId }));
  const rows: TimelineRow[] = tree.map(({ row, depth }) => {
    const ev = events.filter((e) => e.itemId === row.id);
    const started = ev.find((e) => e.toStatus === "in_progress");
    const merged = ev.filter((e) => e.kind === "merged");
    const settled = [...ev].reverse().find((e) => e.toStatus === "settled");
    const actuals: TimelineRow["actuals"] = [];
    if (started) actuals.push({ kind: "started", at: started.at });
    for (const m of merged) actuals.push({ kind: "merged", at: m.at });
    if (settled && row.status === "settled") actuals.push({ kind: "settled", at: settled.at });
    return {
      id: row.id,
      title: row.title,
      kind: row.kind as WorkKind,
      status: row.status as WorkStatus,
      depth,
      startDate: row.startDate,
      targetDate: row.targetDate,
      overdue: !!row.targetDate && row.targetDate < t && !isClosed(row.status),
      validationOverdue: vals.some((v) => v.itemId === row.id && isValidationOverdue(v, t)),
      blocked: blocked.has(row.id),
      actuals,
    };
  });
  const roots = subtree(userId, null)
    .map((t) => t.row)
    .filter((r) => r.kind === "area" || r.kind === "project")
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind as WorkKind }));
  const root = rootId ? tree[0]?.row : null;
  return { root: root ? { id: root.id, title: root.title } : null, roots, rows, dependencies, today: t };
}

/** Visible (not archived, not under an archived branch) items in tree order, with their validations. */
export function itemsWithValidations(userId: string) {
  const rows = subtree(userId, null).map((t) => t.row);
  const ids = rows.map((r) => r.id);
  const vals = ids.length ? getDb().select().from(schema.workValidations).where(inArray(schema.workValidations.itemId, ids)).all() : [];
  return { rows, vals, today: today() };
}

// --- Areas (phase 4): conversations in the tree, settle policy ---

/** session id → the person's conversation node for it. */
export function conversationNodes(userId: string, db: Db = getDb()) {
  const rows = db
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), eq(T.kind, "conversation")))
    .all();
  return new Map(rows.filter((r) => r.sessionId).map((r) => [r.sessionId!, r]));
}

/**
 * Conversations linked to visible work items (work_links), as child rows of
 * those items in the tree. A link whose conversation already has its node
 * under the same item isn't repeated.
 */
export function linkedConversationRows(userId: string, items: WorkItem[]): LinkedConversationRow[] {
  const ids = items.map((i) => i.id);
  if (!ids.length) return [];
  const nodes = new Set(items.filter((i) => i.kind === "conversation" && i.sessionId).map((i) => `${i.parentId}|${i.sessionId}`));
  return getDb()
    .select({ itemId: schema.workLinks.itemId, sessionId: schema.workLinks.targetId, title: schema.workLinks.title })
    .from(schema.workLinks)
    .where(and(inArray(schema.workLinks.itemId, ids), eq(schema.workLinks.kind, "chat_session")))
    .orderBy(asc(schema.workLinks.createdAt))
    .all()
    .filter((l): l is LinkedConversationRow => !!l.sessionId && !nodes.has(`${l.itemId}|${l.sessionId}`));
}

/**
 * Put a conversation in the Areas tree: create its node under `parentId`
 * (null = Miscellaneous) or move its existing node there (a normal Move:
 * lineage + undo). Callers check first that the person can open the
 * conversation (createSession, getSessionDetail). Hermes keeps the content;
 * Jarvis keeps placement, lineage and lifecycle.
 */
export function placeConversation(
  user: CurrentUser,
  v: { sessionId: string; parentId: string | null; title: string; forkedFromSessionId?: string | null },
  correlationId: string,
  out?: OpOut,
): WorkItem {
  const existing = conversationNodes(user.id).get(v.sessionId);
  const db = getDb();
  if (existing) {
    const target = v.parentId ?? ensureMiscellaneous(user.id).id;
    if (target === existing.parentId) return toItem(existing);
    const parent = ownedItem(user.id, target);
    if (parent.kind === "note") throw new HttpError(400, "note_parent", "Notes can't hold conversations");
    return moveItem(user, existing.id, target, correlationId, out);
  }
  const id = db.transaction((tx) => {
    let parentId = v.parentId;
    if (parentId) {
      const parent = ownedItem(user.id, parentId, tx);
      if (parent.kind === "note") throw new HttpError(400, "note_parent", "Notes can't hold conversations");
    } else parentId = ensureMiscellaneous(user.id, tx).id;
    const id = insertItem(tx, user.id, {
      parentId,
      kind: "conversation",
      title: v.title.trim().slice(0, 200) || "New conversation",
      sessionId: v.sessionId,
      status: "exploring",
    });
    event(tx, id, user.id, { kind: "created", to: "exploring", reason: "Conversation" });
    if (v.forkedFromSessionId) {
      const from = conversationNodes(user.id, tx).get(v.forkedFromSessionId);
      if (from) lineage(tx, user.id, { childId: id, parentId: from.id, relation: "forked_from", actor: user.id });
    }
    return id;
  });
  audit({ actor: user.id, action: "work.conversation_place", source: "work", sourceRecord: id, result: "ok", correlationId, detail: { session: v.sessionId } });
  return toItem(ownedItem(user.id, id));
}

/** Keep conversation node titles in step with the assistant's titles (Hermes renames sessions after the first turn). */
export function syncConversationTitles(userId: string, sessions: { id: string; title?: string | null }[]) {
  const nodes = conversationNodes(userId);
  if (!nodes.size) return 0;
  let n = 0;
  getDb().transaction((tx) => {
    for (const s of sessions) {
      const node = nodes.get(s.id);
      const title = s.title?.trim().slice(0, 200);
      if (node && title && title !== node.title) {
        tx.update(T).set({ title }).where(eq(T.id, node.id)).run();
        n++;
      }
    }
  });
  return n;
}

/**
 * Apply each area's settle policy (settle-rules.ts) to the person's open work:
 * returns the ids to suggest, and settles (with an undo op) the ones whose
 * area opted into `auto_after_quiet`. Deterministic; called when Today loads.
 */
export function settleReview(userId: string, now = new Date()) {
  const db = getDb();
  const rows = allRows(userId, db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hidden = (r: ItemRow) => {
    for (let c: ItemRow | undefined = r, n = 0; c && n < 100; c = c.parentId ? byId.get(c.parentId) : undefined, n++) if (c.archived) return true;
    return false;
  };
  const open = rows.filter((r) => r.parentId !== null && !isClosed(r.status) && !hidden(r));
  if (!open.length) return { suggest: [] as string[], settled: [] as string[] };
  const merged = new Set(
    db
      .select({ itemId: schema.workLinks.itemId })
      .from(schema.workLinks)
      .where(
        and(
          inArray(
            schema.workLinks.itemId,
            open.map((r) => r.id),
          ),
          eq(schema.workLinks.kind, "github_pr"),
          eq(schema.workLinks.role, "implementation"),
          eq(schema.workLinks.externalState, "merged"),
        ),
      )
      .all()
      .map((l) => l.itemId),
  );
  const suggest: string[] = [];
  const settled: string[] = [];
  for (const r of open) {
    if (!merged.has(r.id)) continue;
    const area = areaOf(r, byId);
    const settings = parseAreaSettings(area?.settings);
    const lastEvent = db
      .select({ at: schema.workEvents.at })
      .from(schema.workEvents)
      .where(eq(schema.workEvents.itemId, r.id))
      .orderBy(desc(schema.workEvents.at))
      .get();
    const facts = {
      status: r.status as WorkStatus,
      kind: r.kind,
      archived: r.archived,
      merged: true,
      gateAllowed: settleGate(latestPacket(r.id, db), validationsOf(r.id, db) as { status: WorkValidation["status"] }[]).allowed,
      lastActivityAt: [r.updatedAt, lastEvent?.at ?? ""].sort().at(-1)!,
    };
    const signals = settleSignals(facts, settings.quietDays, now);
    const decision = settleDecision(settings.settlePolicy, signals, facts);
    if (decision === "suggest") suggest.push(r.id);
    else if (decision === "auto") {
      const reason = `Settled automatically: ${signals.reasons.join(", ")} (${area?.title ?? "area"} policy)`;
      db.transaction((tx) => {
        const at = now.toISOString();
        tx.update(T).set({ status: "settled", settledKind: "auto", settledReason: reason, completedAt: at, updatedAt: at }).where(eq(T.id, r.id)).run();
        event(tx, r.id, "jarvis", { kind: "status", from: r.status, to: "settled", reason });
        recordOp(tx, userId, r.id, "settle", { fromStatus: r.status });
      });
      audit({
        actor: "jarvis",
        action: "work.status",
        source: "work",
        sourceRecord: r.id,
        result: "ok",
        correlationId: `settle-policy:${r.id}`,
        detail: { from: r.status, to: "settled", auto: true },
      });
      settled.push(r.id);
    }
  }
  return { suggest, settled };
}

/** Auto-settled items of the last 7 days with the undo op that can still reopen them. */
export function recentAutoSettled(userId: string, now = new Date()) {
  const since = new Date(now.getTime() - AUTO_SETTLE_UNDO_MS).toISOString();
  const rows = allRows(userId).filter((r) => r.status === "settled" && r.settledKind === "auto" && (r.completedAt ?? "") >= since);
  return rows.map((r) => {
    const latest = latestOp(
      getDb()
        .select()
        .from(schema.workOps)
        .where(and(eq(schema.workOps.userId, userId), eq(schema.workOps.itemId, r.id)))
        .all(),
    );
    return { row: r, opId: latest && latest.kind === "settle" && !latest.undoneAt ? latest.id : null };
  });
}
