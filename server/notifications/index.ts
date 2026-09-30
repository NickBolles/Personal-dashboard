import "server-only";
import { and, desc, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { getOwner } from "@/server/auth";
import { categoryPushEnabled, getPreferences } from "@/server/settings";
import type { ActionSource, JarvisNotification, NotificationCategory, NotificationSeverity } from "@/lib/contracts";

export type NotifyInput = {
  type: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string;
  source: ActionSource | "jarvis";
  deepLink: string;
  dedupeKey?: string;
  scheduledFor?: string;
};

type Row = typeof schema.notifications.$inferSelect;

export function toNotification(r: Row): JarvisNotification {
  return {
    id: r.id,
    type: r.type,
    category: r.category as NotificationCategory,
    severity: r.severity as NotificationSeverity,
    title: r.title,
    body: r.body,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    readAt: r.readAt ?? undefined,
    dismissedAt: r.dismissedAt ?? undefined,
    actedAt: r.actedAt ?? undefined,
    dedupeKey: r.dedupeKey ?? undefined,
    occurrences: r.occurrences,
    deepLink: r.deepLink,
    source: r.source as JarvisNotification["source"],
  };
}

/**
 * Create or update the canonical inbox record. Repeated source events with the
 * same dedupeKey update one record instead of creating duplicates. Push is only
 * queued for new records whose category has push enabled.
 */
export function notify(input: NotifyInput, userId = getOwner()?.id) {
  if (!userId) return undefined;
  const db = getDb();
  const now = new Date().toISOString();
  if (input.dedupeKey) {
    const existing = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.dedupeKey, input.dedupeKey)))
      .get();
    if (existing) {
      const escalated = severityRank(input.severity) < severityRank(existing.severity as NotificationSeverity);
      db.update(schema.notifications)
        .set({
          title: input.title,
          body: input.body,
          severity: escalated ? input.severity : existing.severity,
          occurrences: existing.occurrences + 1,
          updatedAt: now,
          // An escalation is new information: surface it again.
          ...(escalated ? { readAt: null, pushState: pushWanted(input.category) ? "pending" : existing.pushState } : {}),
        })
        .where(eq(schema.notifications.id, existing.id))
        .run();
      return { id: existing.id, created: false };
    }
  }
  const id = newId("ntf");
  db.insert(schema.notifications)
    .values({
      id,
      userId,
      type: input.type,
      category: input.category,
      severity: input.severity,
      title: input.title,
      body: input.body,
      source: input.source,
      deepLink: input.deepLink,
      dedupeKey: input.dedupeKey,
      pushState: pushWanted(input.category) ? "pending" : null,
      scheduledFor: input.scheduledFor,
    })
    .run();
  return { id, created: true };
}

function pushWanted(category: NotificationCategory) {
  return categoryPushEnabled(getPreferences(), category);
}

const RANK: Record<NotificationSeverity, number> = { critical: 0, high: 1, normal: 2, info: 3 };
const severityRank = (s: NotificationSeverity) => RANK[s] ?? 3;

export function listNotifications(userId: string, filter: "inbox" | "all" = "inbox", limit = 100) {
  const where =
    filter === "inbox" ? and(eq(schema.notifications.userId, userId), isNull(schema.notifications.dismissedAt)) : eq(schema.notifications.userId, userId);
  return getDb().select().from(schema.notifications).where(where).orderBy(desc(schema.notifications.updatedAt)).limit(limit).all().map(toNotification);
}

/** Badge count: unread, undismissed, un-acted actionable items (info is not actionable). */
export function unreadActionableCount(userId: string) {
  const r = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
        isNull(schema.notifications.dismissedAt),
        isNull(schema.notifications.actedAt),
        ne(schema.notifications.severity, "info"),
      ),
    )
    .get();
  return Number(r?.n ?? 0);
}

export type NotificationTransition = "read" | "unread" | "dismiss" | "restore" | "acted";

export function transition(userId: string, id: string, t: NotificationTransition) {
  const now = new Date().toISOString();
  const set =
    t === "read"
      ? { readAt: now }
      : t === "unread"
        ? { readAt: null }
        : t === "dismiss"
          ? { dismissedAt: now }
          : t === "restore"
            ? { dismissedAt: null }
            : { actedAt: now, readAt: now };
  const res = getDb()
    .update(schema.notifications)
    .set(set)
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)))
    .run();
  return res.changes > 0;
}

export function markAllRead(userId: string) {
  getDb()
    .update(schema.notifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)))
    .run();
}

export function pendingPushes(now = new Date()) {
  return getDb()
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.pushState, "pending"),
        or(isNull(schema.notifications.scheduledFor), lte(schema.notifications.scheduledFor, now.toISOString())),
      ),
    )
    .all();
}

export function setPushState(id: string, state: "sent" | "suppressed" | "failed" | "pending") {
  getDb().update(schema.notifications).set({ pushState: state, pushAttemptedAt: new Date().toISOString() }).where(eq(schema.notifications.id, id)).run();
}

export function pruneNotifications(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  getDb()
    .delete(schema.notifications)
    .where(
      and(
        lt(schema.notifications.updatedAt, cutoff),
        or(sql`${schema.notifications.dismissedAt} is not null`, sql`${schema.notifications.actedAt} is not null`),
      ),
    )
    .run();
}
