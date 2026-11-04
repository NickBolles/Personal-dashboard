import "server-only";
import { and, asc, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import { currentVia } from "@/server/work/actor";
import { recordOp, undoOp } from "@/server/work/store";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { quickActionInput, quickActionPatch, quickActionScope, type QuickActionInput } from "@/lib/quick-actions";

const T = schema.quickActions;
type Row = typeof T.$inferSelect;
type Db = ReturnType<typeof getDb>;
export const QUICK_ACTION_OPS_ITEM = "quick-actions";
const defaults = [
  "What needs me?",
  "Walk me through decisions",
  "What changed since I last looked",
  "What's running / stalled",
  "Plan my day",
  "Catch me up on {area}",
  "Summarize this page",
];
function owned(db: Db, userId: string, id: string) {
  const row = db
    .select()
    .from(T)
    .where(and(eq(T.id, id), eq(T.userId, userId), ne(T.status, "deleted")))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That quick action isn't here");
  return row;
}
function log(db: Db, userId: string, rows: Row[]) {
  return recordOp(db, userId, QUICK_ACTION_OPS_ITEM, "quick_action", { rows });
}
function seed(userId: string) {
  getDb().transaction((tx) => {
    const key = `quick-actions:seeded:${userId}`;
    if (tx.select().from(schema.settings).where(eq(schema.settings.key, key)).get()) return;
    const at = new Date().toISOString();
    const rows = defaults.map((label, i): Row => ({
      id: newId("qa"),
      userId,
      label,
      prompt: label === "Summarize this page" ? "Summarize this page: {page}" : label,
      scope: "global",
      pinned: false,
      sortOrder: i,
      status: "active",
      source: "seed",
      createdAt: at,
      updatedAt: at,
    }));
    tx.insert(T).values(rows).run();
    log(
      tx,
      userId,
      rows.map((r) => ({ ...r, status: "deleted" })),
    );
    tx.insert(schema.settings).values({ key, value: "true", updatedAt: at }).run();
  });
}
export function list(userId: string, options: { scope?: string } = {}) {
  if (options.scope) quickActionScope.parse(options.scope);
  seed(userId);
  return getDb()
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), ne(T.status, "deleted")))
    .orderBy(asc(T.sortOrder), asc(T.id))
    .all()
    .filter((r) => !options.scope || r.scope === "global" || r.scope === options.scope);
}
function insert(userId: string, input: QuickActionInput, source: string, status: "active" | "proposed") {
  const body = quickActionInput.parse(input);
  // Agent proposal writes must never activate even the default rows. Owner reads seed them.
  if (status === "active") seed(userId);
  return getDb().transaction((tx) => {
    const at = new Date().toISOString();
    const order = tx
      .select()
      .from(T)
      .where(eq(T.userId, userId))
      .all()
      .reduce((n, r) => Math.max(n, r.sortOrder + 1), 0);
    const row: Row = {
      id: newId("qa"),
      userId,
      ...body,
      scope: body.scope ?? "global",
      pinned: body.pinned ?? false,
      sortOrder: order,
      status,
      source,
      createdAt: at,
      updatedAt: at,
    };
    tx.insert(T).values(row).run();
    const opId = log(tx, userId, [{ ...row, status: "deleted" }]);
    audit({
      actor: currentVia() ?? userId,
      action: `quick_action.${status === "proposed" ? "propose" : "create"}`,
      source: "work",
      sourceRecord: row.id,
      result: "ok",
      correlationId: row.id,
    });
    return { action: row, opId };
  });
}
export function create(userId: string, input: QuickActionInput) {
  return insert(userId, input, "owner", "active");
}
export function propose(userId: string, profile: string, input: QuickActionInput) {
  return insert(userId, input, `agent:${profile}`, "proposed");
}
function change(userId: string, id: string, input: Partial<QuickActionInput>, transition?: "active" | "deleted", proposedOnly = false) {
  const patch = quickActionPatch.parse(input);
  return getDb().transaction((tx) => {
    const prev = owned(tx, userId, id);
    if (proposedOnly && prev.status !== "proposed") throw new HttpError(409, "not_proposed", "That proposal has already been reviewed");
    tx.update(T)
      .set({ ...patch, ...(transition ? { status: transition } : {}), updatedAt: new Date().toISOString() })
      .where(eq(T.id, id))
      .run();
    const opId = log(tx, userId, [prev]);
    audit({
      actor: currentVia() ?? userId,
      action: `quick_action.${transition ?? "update"}`,
      source: "work",
      sourceRecord: id,
      result: "ok",
      correlationId: opId,
    });
    return { action: tx.select().from(T).where(eq(T.id, id)).get()!, opId };
  });
}
export function update(userId: string, id: string, patch: Partial<QuickActionInput>) {
  return change(userId, id, patch);
}
export function remove(userId: string, id: string) {
  return change(userId, id, {}, "deleted");
}
export function accept(userId: string, id: string, edits: Partial<QuickActionInput> = {}) {
  return change(userId, id, edits, "active", true);
}
export function dismiss(userId: string, id: string) {
  return change(userId, id, {}, "deleted", true);
}
export function reorder(userId: string, ids: string[]) {
  if (!ids.length || ids.length > 500 || new Set(ids).size !== ids.length) throw new HttpError(400, "order", "Give unique active quick action ids");
  return getDb().transaction((tx) => {
    const rows = ids.map((id) => owned(tx, userId, id));
    if (rows.some((r) => r.status !== "active")) throw new HttpError(400, "order", "Only active actions can be reordered");
    const remaining = tx
      .select()
      .from(T)
      .where(and(eq(T.userId, userId), eq(T.status, "active")))
      .orderBy(asc(T.sortOrder), asc(T.id))
      .all()
      .filter((r) => !ids.includes(r.id));
    const ordered = [...rows, ...remaining];
    const at = new Date().toISOString();
    ordered.forEach((r, i) => tx.update(T).set({ sortOrder: i, updatedAt: at }).where(eq(T.id, r.id)).run());
    return { opId: log(tx, userId, ordered) };
  });
}
export function undo(user: CurrentUser, opId: string) {
  const op = getDb()
    .select()
    .from(schema.workOps)
    .where(and(eq(schema.workOps.id, opId), eq(schema.workOps.userId, user.id), eq(schema.workOps.kind, "quick_action")))
    .get();
  if (!op) throw new HttpError(404, "not_found", "Nothing to undo");
  return undoOp(user, opId, opId);
}
export function exportJson(userId: string) {
  return list(userId)
    .filter((r) => r.status === "active")
    .map(({ label, prompt, scope, pinned }) => ({ label, prompt, scope, pinned }));
}
