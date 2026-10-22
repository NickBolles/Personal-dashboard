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
  isClosed,
  parseGithubUrl,
  safeHref,
  type createItemSchema,
  type ExternalState,
  type GithubRefreshResult,
  type linkSchema,
  type packetSchema,
  type splitSchema,
  type TimelineResponse,
  type TimelineRow,
  type updateItemSchema,
  type validationSchema,
  type validationUpdateSchema,
  type WorkDetail,
  type WorkEvent,
  type WorkItem,
  type WorkKind,
  type WorkLineage,
  type WorkLink,
  type WorkPacket,
  type WorkStatus,
  type WorkValidation,
} from "@/lib/work";
import type { z } from "zod";
import { evaluateValidation, LifecycleError, nextPacketVersion, onImplementationMerged, planTransition, settleGate, wouldCreateCycle } from "./lifecycle";
import { fetchIssueState, fetchPullState, githubRefreshEnabled } from "./github";
import { claimCutoff, dueForRefresh, REFRESH_PARALLELISM } from "./refresh-rules";
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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
const toLink = (r: typeof schema.workLinks.$inferSelect): WorkLink => ({
  ...r,
  kind: r.kind as WorkLink["kind"],
  role: r.role as WorkLink["role"],
  externalState: r.externalState as ExternalState | null,
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
    githubRefresh: githubRefreshEnabled(),
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
  v: { parentId: string | null; kind: WorkKind; title: string; summary?: string; nextAction?: string; startDate?: string | null; targetDate?: string | null },
) {
  const id = newId("wk");
  db.insert(T)
    .values({
      id,
      userId,
      parentId: v.parentId,
      kind: v.kind,
      title: v.title,
      summary: v.summary ?? "",
      nextAction: v.nextAction ?? "",
      startDate: v.startDate ?? null,
      targetDate: v.targetDate ?? null,
      sortOrder: nextSort(userId, v.parentId, db),
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

export function updateItem(user: CurrentUser, id: string, body: z.infer<typeof updateItemSchema>, correlationId: string): WorkItem {
  const { status, reason, ...fields } = body;
  const result = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    if (row.systemKey && (fields.archived || (fields.kind && fields.kind !== "area"))) throw new HttpError(409, "built_in", "Miscellaneous is built in");
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
    if (fields.archived !== undefined && fields.archived !== row.archived) event(tx, id, user.id, { kind: fields.archived ? "archived" : "unarchived" });
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
  return toItem(ownedItem(user.id, id));
}

export function moveItem(user: CurrentUser, id: string, parentId: string | null, correlationId: string): WorkItem {
  getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    if (row.systemKey) throw new HttpError(409, "built_in", "Miscellaneous is built in");
    if (parentId === row.parentId) return;
    if (parentId === null && row.kind !== "area") throw new HttpError(400, "top_level", "Only areas can sit at the top level");
    if (parentId) ownedItem(user.id, parentId, tx);
    const parents = new Map(allRows(user.id, tx).map((r) => [r.id, r.parentId]));
    if (wouldCreateCycle(parents, id, parentId)) throw new HttpError(409, "cycle", "Can't move an item inside itself");
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

export function reorderItem(user: CurrentUser, id: string, direction: "up" | "down"): WorkItem[] {
  getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    const siblings = allRows(user.id, tx)
      .filter((r) => r.parentId === row.parentId && !r.archived)
      .sort(byOrder);
    const i = siblings.findIndex((s) => s.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return;
    [siblings[i], siblings[j]] = [siblings[j]!, siblings[i]!];
    siblings.forEach((s, n) => {
      if (s.systemKey) return; // Miscellaneous stays last among areas
      tx.update(T).set({ sortOrder: n }).where(eq(T.id, s.id)).run();
    });
  });
  return listItems(user.id);
}

export function forkItem(user: CurrentUser, id: string, title: string | undefined, correlationId: string): WorkItem {
  const forkId = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    if (row.systemKey || row.parentId === null) throw new HttpError(409, "fork_area", "Areas can't be forked");
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
    return forkId;
  });
  audit({ actor: user.id, action: "work.fork", source: "work", sourceRecord: forkId, result: "ok", correlationId, detail: { from: id } });
  return toItem(ownedItem(user.id, forkId));
}

export function splitItem(user: CurrentUser, id: string, body: z.infer<typeof splitSchema>, correlationId: string): WorkItem {
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
    return childId;
  });
  audit({ actor: user.id, action: "work.split", source: "work", sourceRecord: childId, result: "ok", correlationId, detail: { from: id } });
  return toItem(ownedItem(user.id, childId));
}

export function createPacket(user: CurrentUser, id: string, body: z.infer<typeof packetSchema>, correlationId: string): WorkPacket {
  const out = getDb().transaction((tx) => {
    const row = ownedItem(user.id, id, tx);
    const existing = tx.select({ version: schema.workPackets.version }).from(schema.workPackets).where(eq(schema.workPackets.itemId, id)).all();
    const version = nextPacketVersion(existing);
    const pid = newId();
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
        validationRequired: body.validationRequired,
        noValidationReason: body.validationRequired ? null : (body.noValidationReason?.trim() ?? null),
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
  const outcome = getDb().transaction((tx) => {
    const { link, item } = ownedLink(user.id, linkId, tx);
    if (link.kind !== "github_pr" && link.kind !== "github_issue") throw new HttpError(400, "not_github", "Only GitHub links have a state");
    if (link.externalState === state) return null;
    tx.update(schema.workLinks).set({ externalState: state, stateChangedAt: nowIso() }).where(eq(schema.workLinks.id, linkId)).run();
    const number = Number(link.targetId?.split("#")[1]) || null;
    const label = `${link.kind === "github_pr" ? "PR" : "Issue"} #${number ?? "?"}`;
    event(tx, item.id, user.id, {
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
    event(tx, item.id, user.id, { kind: "status", from: item.status, to: plan.status, reason, source: via });
    return { itemId: item.id, transition: { from: item.status, to: plan.status, reason } };
  });
  audit({ actor: user.id, action: "work.link_state", source: "work", sourceRecord: linkId, result: "ok", correlationId, detail: { state, via } });
  if (outcome?.transition)
    audit({ actor: user.id, action: "work.status", source: "work", sourceRecord: outcome.itemId, result: "ok", correlationId, detail: outcome.transition });
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
async function readBack(user: CurrentUser, link: typeof schema.workLinks.$inferSelect, correlationId: string) {
  const ref = parseGithubUrl(link.url ?? "");
  if (!ref) throw new HttpError(400, "github_url", "Not a GitHub link");
  try {
    const remote = link.kind === "github_pr" ? await fetchPullState(ref) : await fetchIssueState(ref);
    const db = getDb();
    const patch: Partial<typeof schema.workLinks.$inferInsert> = { checkedAt: nowIso(), checkError: null };
    if (remote.title && link.title === `${ref.owner}/${ref.repo}#${ref.number}`) patch.title = `${remote.title} (#${ref.number})`;
    db.update(schema.workLinks).set(patch).where(eq(schema.workLinks.id, link.id)).run();
    return setLinkState(user, link.id, remote.state, correlationId, "github");
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
  if (!githubRefreshEnabled()) throw new HttpError(409, "github_not_configured", "Set JARVIS_GITHUB_TOKEN to refresh from GitHub");
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
      validationOverdue: vals.some((v) => v.itemId === row.id && v.status === "pending" && !!v.dueDate && v.dueDate < t),
      actuals,
    };
  });
  const roots = subtree(userId, null)
    .map((t) => t.row)
    .filter((r) => r.kind === "area" || r.kind === "project")
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind as WorkKind }));
  const root = rootId ? tree[0]?.row : null;
  return { root: root ? { id: root.id, title: root.title } : null, roots, rows, today: t };
}

/** Visible (not archived, not under an archived branch) items in tree order, with their validations. */
export function itemsWithValidations(userId: string) {
  const rows = subtree(userId, null).map((t) => t.row);
  const ids = rows.map((r) => r.id);
  const vals = ids.length ? getDb().select().from(schema.workValidations).where(inArray(schema.workValidations.itemId, ids)).all() : [];
  return { rows, vals, today: today() };
}
