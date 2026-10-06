import "server-only";
import webpush from "web-push";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { decrypt, encrypt, newId } from "@/server/crypto";
import { config } from "@/server/config";
import { getSetting, setSetting, getPreferences } from "@/server/settings";
import { inWindow, localMinutes } from "@/lib/time";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "@/lib/contracts";
import { pendingPushes, setPushState, unreadActionableCount } from "./index";
import { fcmData, sendFcmToUser } from "./fcm";

type Vapid = { publicKey: string; privateKey: string };

/** VAPID keys: env override, else generated once and stored encrypted. */
export function getVapid(): Vapid {
  if (process.env.JARVIS_VAPID_PUBLIC_KEY && process.env.JARVIS_VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.JARVIS_VAPID_PUBLIC_KEY, privateKey: process.env.JARVIS_VAPID_PRIVATE_KEY };
  }
  const stored = getSetting<{ publicKey: string; privateKey: string }>("vapid");
  if (stored) return { publicKey: stored.publicKey, privateKey: decrypt(stored.privateKey) };
  const keys = webpush.generateVAPIDKeys();
  setSetting("vapid", { publicKey: keys.publicKey, privateKey: encrypt(keys.privateKey) });
  return keys;
}

export type PushPayload = {
  id: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
  severity: string;
};

export function saveSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string | null) {
  const values = {
    id: newId("push"),
    userId,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    userAgent: userAgent?.slice(0, 200),
    failureCount: 0,
  };
  getDb()
    .insert(schema.pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint, set: { p256dh: values.p256dh, auth: values.auth, userId, failureCount: 0 } })
    .run();
}

export function removeSubscription(endpoint: string) {
  getDb().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint)).run();
}

export function listSubscriptions(userId: string) {
  return getDb().select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId)).all();
}

export async function sendToUser(userId: string, payload: PushPayload, opts: { urgency?: "high" | "normal" | "low" } = {}) {
  const subs = listSubscriptions(userId);
  if (!subs.length) return { sent: 0, failed: 0, total: 0 };
  const vapid = getVapid();
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
          vapidDetails: { subject: config.vapidSubject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: 60 * 60 * 12,
          urgency: opts.urgency ?? "normal",
          topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
          timeout: 10_000,
        });
        sent++;
        getDb()
          .update(schema.pushSubscriptions)
          .set({ lastSuccessAt: new Date().toISOString(), failureCount: 0 })
          .where(eq(schema.pushSubscriptions.id, s.id))
          .run();
      } catch (err) {
        failed++;
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) removeSubscription(s.endpoint);
        else {
          getDb()
            .update(schema.pushSubscriptions)
            .set({ failureCount: s.failureCount + 1 })
            .where(eq(schema.pushSubscriptions.id, s.id))
            .run();
          console.warn(`[jarvis] push failed (${status ?? "network"})`);
        }
      }
    }),
  );
  return { sent, failed, total: subs.length };
}

export function inQuietHours(now = new Date()) {
  const p = getPreferences();
  if (!p.quietHours.enabled) return false;
  return inWindow(localMinutes(now, p.timezone), p.quietHours.start, p.quietHours.end);
}

/** Outbox worker: deliver queued pushes, respecting quiet hours and read state. */
export async function deliverPendingPushes(now = new Date()) {
  const quiet = inQuietHours(now);
  let delivered = 0;
  for (const n of pendingPushes(now)) {
    if (n.readAt || n.dismissedAt || n.actedAt) {
      setPushState(n.id, "suppressed");
      continue;
    }
    const cat = NOTIFICATION_CATEGORIES.find((c) => c.id === (n.category as NotificationCategory));
    if (quiet && !(cat?.bypassQuietHours || n.severity === "critical")) continue; // hold until quiet hours end
    const payload = { id: n.id, title: n.title, body: n.body, url: n.deepLink, tag: n.dedupeKey ?? n.id, severity: n.severity };
    const urgency = n.severity === "critical" || n.category === "hermes_input" ? "high" : "normal";
    // Browsers (web push) and paired phones (FCM) both get it.
    const [web, phone] = await Promise.all([
      sendToUser(n.userId, payload, { urgency }),
      sendFcmToUser(n.userId, fcmData({ ...payload, category: n.category, unread: unreadActionableCount(n.userId) }), { urgency }),
    ]);
    const total = web.total + phone.total;
    const sent = web.sent + phone.sent;
    setPushState(n.id, total === 0 ? "suppressed" : sent > 0 ? "sent" : "failed");
    delivered += sent;
  }
  return delivered;
}
