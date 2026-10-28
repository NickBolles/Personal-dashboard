import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { adapterContext, cachedSource, scopeResult } from "@/server/sources";
import { listItems } from "@/server/work/store";
import { effectiveAreaPolicy } from "@/server/ai/rules";
import { getSetting, setSetting } from "@/server/settings";
import { localDate } from "@/lib/time";
import { LIMITS, type JarvisSpec } from "@/lib/jarvis-ui/catalog";
import { canonicalJson, validateSpec } from "@/lib/jarvis-ui/validator";
import type { AppliedEntry, HydratedRef, SmartSettings, SurfaceView } from "@/lib/jarvis-ui/types";
import type { NextAction } from "@/lib/contracts";
import type { WorkItem } from "@/lib/work";

const T = schema.uiSurfaces;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// --- settings (feature flag, default OFF) ---

const settingsKey = (userId: string) => `smart:user:${userId}`;

export function getSmartSettings(userId: string): SmartSettings {
  const s = getSetting<Partial<SmartSettings>>(settingsKey(userId));
  return { enabled: s?.enabled === true, calendarWrites: s?.calendarWrites === true };
}

export function saveSmartSettings(userId: string, patch: Partial<SmartSettings>): SmartSettings {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === "boolean"));
  const next = { ...getSmartSettings(userId), ...clean };
  setSetting(settingsKey(userId), next);
  return next;
}

export function requireSmart(user: CurrentUser) {
  if (!getSmartSettings(user.id).enabled) throw new HttpError(403, "smart_off", "Smart replies are off. Turn them on in Settings.");
}

export function todayLocal(now = new Date()) {
  return localDate(now, adapterContext(now).timezone);
}

// --- hydration ---

type Lookup = { todo: (ref: string) => HydratedRef; item: (ref: string) => HydratedRef; items: Map<string, WorkItem> };

function todoActions(user: CurrentUser): NextAction[] {
  return scopeResult(user, cachedSource("todos"))?.data?.actions ?? [];
}

function dueDate(a: NextAction, tz: string) {
  // Date-only todos carry the end of that local day as an instant (integrations/actions.ts).
  return a.dueAt ? localDate(new Date(a.dueAt), tz) : undefined;
}

/** Area (top-level ancestor) of an item. */
function areaOf(item: WorkItem, byId: Map<string, WorkItem>) {
  let cur: WorkItem | undefined = item;
  for (let n = 0; cur?.parentId && n < 100; n++) cur = byId.get(cur.parentId);
  return cur && !cur.parentId ? cur : null;
}

/** True when an item lives under Finance (or an area that excludes AI): never hydrated or written from a smart surface. */
export function itemExcluded(item: WorkItem, byId: Map<string, WorkItem>) {
  const area = areaOf(item, byId);
  return area ? effectiveAreaPolicy({ title: area.title, systemKey: null, aiPolicy: area.settings?.aiPolicy }) === "excluded" : false;
}

export function lookup(user: CurrentUser): Lookup {
  const tz = adapterContext().timezone;
  let todos: Map<string, NextAction> | undefined;
  let items: Map<string, WorkItem> | undefined;
  const itemMap = () => (items ??= can(user, "work.use") ? new Map(listItems(user.id, { includeArchived: true }).map((i) => [i.id, i])) : new Map());
  return {
    get items() {
      return itemMap();
    },
    todo(ref) {
      if (!can(user, "todos.view")) return { ref, unavailable: "forbidden" };
      todos ??= new Map(todoActions(user).map((a) => [a.sourceId, a]));
      const a = todos.get(ref.slice("todo:".length));
      if (!a) return { ref, unavailable: "unknown" };
      return {
        ref,
        kind: "todo",
        title: a.title,
        due: dueDate(a, tz),
        status: a.status,
        where: "Todos",
        href: a.href,
        done: a.status === "completed",
        // a due time (not just a date) can't be restored by a date-only snooze
        timed: Boolean(a.dueAt && !a.dueIsDate),
      };
    },
    item(ref) {
      if (!can(user, "work.use")) return { ref, unavailable: "forbidden" };
      const map = itemMap();
      const it = map.get(ref.slice("item:".length));
      if (!it || it.kind === "conversation") return { ref, unavailable: "unknown" };
      if (itemExcluded(it, map)) return { ref, unavailable: "finance" };
      const area = areaOf(it, map);
      return {
        ref,
        kind: "item",
        title: it.title,
        due: it.targetDate ?? undefined,
        status: it.status,
        where: area && area.id !== it.id ? area.title : undefined,
        href: `/areas?item=${encodeURIComponent(it.id)}`,
        done: it.archived || ["settled", "abandoned", "superseded"].includes(it.status),
      };
    },
  };
}

export async function hydrate(user: CurrentUser, refs: string[]): Promise<Record<string, HydratedRef>> {
  const l = lookup(user);
  const out: Record<string, HydratedRef> = {};
  const data = await import("./data");
  const prs: Promise<void>[] = [];
  let prCount = 0;
  for (const ref of [...new Set(refs)].slice(0, LIMITS.hydrateRefs)) {
    if (ref.startsWith("todo:")) out[ref] = l.todo(ref);
    else if (ref.startsWith("item:")) out[ref] = l.item(ref);
    else if (ref.startsWith("metric:")) {
      const id = ref.slice(7);
      out[ref] = data.isMetric(id) ? data.metric(user, id) : { ref, unavailable: "unknown" };
    } else if (ref.startsWith("cal:week:")) out[ref] = data.calendarWeek(user, ref);
    // A reply may show a few PR cards; each costs read-only GitHub GETs (cached 60 s).
    else if (ref.startsWith("pr:") && ++prCount <= 5) prs.push(data.pullRequest(user, ref).then((h) => void (out[ref] = h)));
    else out[ref] = { ref, unavailable: "unknown" };
  }
  await Promise.all(prs);
  return out;
}

// --- surfaces ---

type Row = typeof T.$inferSelect;

export function toView(row: Row, user: CurrentUser): SurfaceView {
  return {
    id: row.id,
    specHash: row.specHash,
    state: JSON.parse(row.stateJson) as Record<string, unknown>,
    applied: JSON.parse(row.appliedJson) as AppliedEntry[],
    readOnly: row.userId !== user.id,
  };
}

export function ownedSurface(userId: string, id: string): Row {
  const row = getDb()
    .select()
    .from(T)
    .where(and(eq(T.id, id), eq(T.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That reply isn't available");
  return row;
}

export function storedSpec(row: Row): JarvisSpec {
  return JSON.parse(row.specJson) as JarvisSpec;
}

/**
 * Upsert on first render. The client sends the block it parsed; the server
 * re-validates it and stores the canonical form, keyed by its hash (the
 * message key, spec §4.6), so the live stream and the stored transcript reach
 * the same surface. A stored spec is never rewritten, so nothing can widen
 * what apply accepts after the fact.
 */
export function upsertSurface(user: CurrentUser, input: { sessionId: string; blockIndex: number; spec: unknown }): SurfaceView {
  const v = validateSpec(input.spec);
  if (!v.ok) throw new HttpError(400, `invalid_${v.reason}`, "That interactive reply isn't valid");
  const specJson = canonicalJson(v.spec);
  if (specJson.length > LIMITS.blockBytes) throw new HttpError(400, "too_large", "That interactive reply is too large");
  const specHash = sha256(specJson);
  // A conversation shared with this person is read-only: render, but no surface, tray or writes.
  if (!sessionWritable(user.id, input.sessionId)) return { id: "", specHash, state: {}, applied: [], readOnly: true };
  const db = getDb();
  const where = and(eq(T.userId, user.id), eq(T.sessionId, input.sessionId), eq(T.messageKey, specHash), eq(T.blockIndex, input.blockIndex));
  const existing = db.select().from(T).where(where).get();
  if (existing) return toView(existing, user);
  const id = `uis_${newId().replace(/-/g, "").slice(0, 24)}`;
  db.insert(T)
    .values({
      id,
      userId: user.id,
      origin: "message",
      sessionId: input.sessionId,
      messageKey: specHash,
      blockIndex: input.blockIndex,
      catalog: v.spec.catalog,
      specHash,
      specJson,
    })
    .onConflictDoNothing()
    .run();
  return toView(db.select().from(T).where(where).get()!, user);
}

/** Someone else's (shared) conversation is read-only for this person. */
export function sessionWritable(userId: string, sessionId: string) {
  const m = getDb().select({ userId: schema.sessionMeta.userId }).from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, sessionId)).get();
  return !m || m.userId === userId;
}

export function saveState(user: CurrentUser, id: string, state: Record<string, unknown>): SurfaceView {
  const row = ownedSurface(user.id, id);
  const json = JSON.stringify(state);
  if (json.length > LIMITS.stateBytes) throw new HttpError(400, "too_large", "Too much state");
  getDb().update(T).set({ stateJson: json, updatedAt: new Date().toISOString() }).where(eq(T.id, row.id)).run();
  return toView({ ...row, stateJson: json }, user);
}

export function writeApplied(id: string, applied: AppliedEntry[]) {
  getDb()
    .update(T)
    .set({ appliedJson: JSON.stringify(applied), updatedAt: new Date().toISOString() })
    .where(eq(T.id, id))
    .run();
}
