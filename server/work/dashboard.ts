import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import {
  isClosed,
  isValidationOverdue,
  WIDGET_LABELS,
  type DashboardResponse,
  type DashboardWidget,
  type MapNode,
  type WidgetConfig,
  type WidgetData,
  type WidgetItem,
  type WidgetKind,
  type WidgetSize,
  type widgetCreateSchema,
  type widgetUpdateSchema,
  type WorkKind,
  type WorkSnapshot,
  type WorkStatus,
} from "@/lib/work";
import type { z } from "zod";
import { ensureMiscellaneous, itemsWithValidations, subtree, timeline } from "./store";
import { githubRefreshEnabled } from "./github";

/**
 * Per-person dashboard. Native widgets are computed here from work data only
 * (no finance, no link URLs or tokens). Custom HTML widgets get, at most, a
 * read-only snapshot of their chosen area's titles/statuses/dates/next actions.
 */

const W = schema.dashboardWidgets;
const DEFAULT_WIDGETS: { kind: WidgetKind; size: WidgetSize }[] = [
  { kind: "priorities", size: "md" },
  { kind: "awaiting_validation", size: "sm" },
  { kind: "next_actions", size: "md" },
  { kind: "recently_settled", size: "sm" },
];

function ensureDashboard(userId: string) {
  const db = getDb();
  const found = db.select().from(schema.dashboards).where(eq(schema.dashboards.userId, userId)).get();
  if (found) return found;
  return db.transaction((tx) => {
    const id = newId("dash");
    tx.insert(schema.dashboards).values({ id, userId }).onConflictDoNothing().run();
    const d = tx.select().from(schema.dashboards).where(eq(schema.dashboards.userId, userId)).get()!;
    if (d.id === id)
      DEFAULT_WIDGETS.forEach((w, i) =>
        tx.insert(W).values({ id: newId(), dashboardId: id, kind: w.kind, title: WIDGET_LABELS[w.kind], size: w.size, position: i, config: "{}" }).run(),
      );
    return d;
  });
}

function ownedWidget(userId: string, id: string) {
  const d = ensureDashboard(userId);
  const w = getDb()
    .select()
    .from(W)
    .where(and(eq(W.id, id), eq(W.dashboardId, d.id)))
    .get();
  if (!w) throw new HttpError(404, "not_found", "Widget not found");
  return { d, w };
}

function parseConfig(s: string): WidgetConfig {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function inScope(userId: string, rootId: string | null | undefined) {
  if (!rootId) return null;
  try {
    return new Set(subtree(userId, rootId).map((t) => t.row.id));
  } catch {
    return new Set<string>(); // root was deleted/archived: show nothing rather than everything
  }
}

const item = (
  r: { id: string; title: string; status: string; nextAction: string; targetDate: string | null; settledKind?: string | null },
  detail?: string,
): WidgetItem => ({
  id: r.id,
  title: r.title,
  status: r.status as WorkStatus,
  nextAction: r.nextAction,
  targetDate: r.targetDate,
  settledKind: r.settledKind ?? null,
  ...(detail ? { detail } : {}),
});

function mapOf(userId: string, rootId: string | null | undefined): MapNode | null {
  if (!rootId) return null;
  let tree;
  try {
    tree = subtree(userId, rootId);
  } catch {
    return null;
  }
  const nodes = new Map<string, MapNode>();
  let root: MapNode | null = null;
  for (const { row } of tree.slice(0, 200)) {
    const n: MapNode = { id: row.id, title: row.title, status: row.status as WorkStatus, kind: row.kind as WorkKind, children: [] };
    nodes.set(row.id, n);
    if (!root) root = n;
    else nodes.get(row.parentId ?? "")?.children.push(n);
  }
  return root;
}

export function workSnapshot(userId: string, rootId: string | null | undefined): WorkSnapshot {
  const tree = rootId
    ? (() => {
        try {
          return subtree(userId, rootId);
        } catch {
          return [];
        }
      })()
    : subtree(userId, null);
  return {
    generatedAt: new Date().toISOString(),
    root: rootId ? (tree[0]?.row.title ?? null) : null,
    items: tree.slice(0, 500).map(({ row, depth }) => ({
      title: row.title,
      kind: row.kind as WorkKind,
      status: row.status as WorkStatus,
      depth,
      startDate: row.startDate,
      targetDate: row.targetDate,
      nextAction: row.nextAction,
    })),
  };
}

function widgetData(userId: string, kind: WidgetKind, config: WidgetConfig, ctx: ReturnType<typeof itemsWithValidations>): WidgetData {
  const scope = inScope(userId, config.rootId);
  const rows = ctx.rows.filter((r) => !scope || scope.has(r.id));
  switch (kind) {
    case "priorities":
      return {
        kind: "items",
        items: rows
          .filter((r) => r.status === "in_progress" || r.status === "ready")
          .sort(
            (a, b) =>
              (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999") || (a.status === "in_progress" ? -1 : 1) - (b.status === "in_progress" ? -1 : 1),
          )
          .slice(0, 8)
          .map((r) => item(r)),
      };
    case "next_actions":
      return {
        kind: "items",
        items: rows
          .filter((r) => r.nextAction.trim() && !isClosed(r.status) && r.kind !== "area")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 8)
          .map((r) => item(r)),
      };
    case "awaiting_validation":
      return {
        kind: "items",
        items: rows
          .filter((r) => r.status === "awaiting_validation")
          .map((r) => {
            const vs = ctx.vals.filter((v) => v.itemId === r.id);
            const pending = vs.filter((v) => v.status === "pending").length;
            const failed = vs.filter((v) => v.status === "fail").length;
            const overdue = vs.some((v) => isValidationOverdue(v, ctx.today));
            return item(r, [`${pending} pending`, failed ? `${failed} failed` : "", overdue ? "overdue" : ""].filter(Boolean).join(" · "));
          })
          .slice(0, 8),
      };
    case "validation_overdue": {
      const late = rows.map((r) => ({ r, vs: ctx.vals.filter((v) => v.itemId === r.id && isValidationOverdue(v, ctx.today)) })).filter((x) => x.vs.length > 0);
      return {
        kind: "overdue",
        count: late.reduce((n, x) => n + x.vs.length, 0),
        items: late
          .map(({ r, vs }) => {
            const first = vs.map((v) => v.dueDate!).sort()[0]!;
            return { at: first, w: item(r, `${vs.length} overdue · ${vs.map((v) => v.metric).join(", ")} · due ${first}`) };
          })
          .sort((a, b) => a.at.localeCompare(b.at) || a.w.title.localeCompare(b.w.title))
          .slice(0, 8)
          .map((x) => x.w),
      };
    }
    case "recently_settled":
      return {
        kind: "items",
        items: rows
          .filter((r) => r.status === "settled")
          .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
          .slice(0, 8)
          .map((r) => item(r, r.settledReason ?? undefined)),
      };
    case "timeline": {
      const t = timeline(userId, config.rootId ?? null);
      return { kind: "timeline", rows: t.rows.filter((r) => r.startDate || r.targetDate).slice(0, 12), today: t.today };
    }
    case "project_map":
      return { kind: "map", root: mapOf(userId, config.rootId) };
    case "metric":
      return { kind: "metric" };
    case "custom_html":
      return { kind: "custom_html", snapshot: config.injectData ? workSnapshot(userId, config.rootId) : null };
  }
}

export function getDashboard(userId: string): DashboardResponse {
  ensureMiscellaneous(userId);
  const d = ensureDashboard(userId);
  const ctx = itemsWithValidations(userId);
  const widgets: DashboardWidget[] = getDb()
    .select()
    .from(W)
    .where(eq(W.dashboardId, d.id))
    .orderBy(asc(W.position), asc(W.createdAt))
    .all()
    .map((w) => {
      const config = parseConfig(w.config);
      return {
        id: w.id,
        kind: w.kind as WidgetKind,
        title: w.title,
        size: w.size as WidgetSize,
        position: w.position,
        config,
        data: widgetData(userId, w.kind as WidgetKind, config, ctx),
      };
    });
  const areas = ctx.rows
    .filter((r) => r.kind === "area" || r.kind === "project")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind as WorkKind }));
  return { id: d.id, title: d.title, widgets, areas, githubRefresh: githubRefreshEnabled() };
}

function checkRoot(userId: string, rootId: string | null | undefined) {
  if (!rootId) return;
  const ok = itemsWithValidations(userId).rows.some((r) => r.id === rootId);
  if (!ok) throw new HttpError(404, "not_found", "Work item not found");
}

export function addWidget(user: CurrentUser, body: z.infer<typeof widgetCreateSchema>, correlationId: string) {
  const d = ensureDashboard(user.id);
  checkRoot(user.id, body.config?.rootId);
  const count = getDb().select().from(W).where(eq(W.dashboardId, d.id)).all().length;
  if (count >= 30) throw new HttpError(409, "too_many", "A dashboard holds up to 30 widgets");
  const id = newId();
  getDb()
    .insert(W)
    .values({
      id,
      dashboardId: d.id,
      kind: body.kind,
      title: body.title?.trim() || WIDGET_LABELS[body.kind],
      size: body.size ?? (body.kind === "timeline" || body.kind === "custom_html" ? "lg" : "md"),
      position: count,
      config: JSON.stringify(body.config ?? {}),
    })
    .run();
  audit({ actor: user.id, action: "work.widget_add", source: "work", sourceRecord: id, result: "ok", correlationId, detail: { kind: body.kind } });
  return getDashboard(user.id);
}

export function updateWidget(user: CurrentUser, id: string, body: z.infer<typeof widgetUpdateSchema>, correlationId: string) {
  const { d, w } = ownedWidget(user.id, id);
  checkRoot(user.id, body.config?.rootId);
  getDb().transaction((tx) => {
    const patch: Partial<typeof W.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.title) patch.title = body.title;
    if (body.size) patch.size = body.size;
    if (body.config) patch.config = JSON.stringify(body.config);
    tx.update(W).set(patch).where(eq(W.id, id)).run();
    if (body.direction) {
      const all = tx.select().from(W).where(eq(W.dashboardId, d.id)).orderBy(asc(W.position), asc(W.createdAt)).all();
      const i = all.findIndex((x) => x.id === w.id);
      const j = body.direction === "up" ? i - 1 : i + 1;
      if (j >= 0 && j < all.length) [all[i], all[j]] = [all[j]!, all[i]!];
      all.forEach((x, n) => tx.update(W).set({ position: n }).where(eq(W.id, x.id)).run());
    }
  });
  audit({ actor: user.id, action: "work.widget_update", source: "work", sourceRecord: id, result: "ok", correlationId, detail: { kind: w.kind } });
  return getDashboard(user.id);
}

export function removeWidget(user: CurrentUser, id: string, correlationId: string) {
  ownedWidget(user.id, id);
  getDb().delete(W).where(eq(W.id, id)).run();
  audit({ actor: user.id, action: "work.widget_remove", source: "work", sourceRecord: id, result: "ok", correlationId });
  return getDashboard(user.id);
}
