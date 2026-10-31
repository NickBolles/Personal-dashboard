import "server-only";
import webpush from "web-push";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { decrypt, encrypt, newId } from "@/server/crypto";
import { config } from "@/server/config";
import { getSetting, setSetting, getPreferences } from "@/server/settings";
import { HttpError } from "@/server/http/errors";
import { inWindow, localMinutes } from "@/lib/time";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "@/lib/contracts";
import { claimPush, pendingPushes, setPushState, unreadActionableCount } from "./index";
import { fcmData, fcmStatus, sendFcmToUser } from "./fcm";
import { pushDevices } from "@/server/devices";

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
  actions?: { action: string; title: string }[];
};

/**
 * Web Push endpoints must belong to a real browser push service. Anything else
 * would let a signed-in person make Jarvis POST to arbitrary (internal) URLs.
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIXES = [".notify.windows.com", ".push.services.mozilla.com"];

export function isAllowedPushEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && /^[a-z0-9.-]+$/.test(host));
}

export type SubscriptionSource = "android-app" | "browser";

export function saveSubscription(
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string | null,
  source: SubscriptionSource = "browser",
) {
  if (!isAllowedPushEndpoint(sub.endpoint)) throw new HttpError(400, "push_endpoint", "That isn't a browser push service address.");
  const values = {
    id: newId("push"),
    userId,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    userAgent: userAgent?.slice(0, 200),
    source,
    failureCount: 0,
  };
  getDb()
    .insert(schema.pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint, set: { p256dh: values.p256dh, auth: values.auth, userId, source, failureCount: 0 } })
    .run();
}

export function removeSubscription(endpoint: string, userId?: string) {
  const T = schema.pushSubscriptions;
  getDb()
    .delete(T)
    .where(userId ? and(eq(T.endpoint, endpoint), eq(T.userId, userId)) : eq(T.endpoint, endpoint))
    .run();
}

export function listSubscriptions(userId: string) {
  return getDb().select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId)).all();
}

export async function sendToUser(userId: string, payload: PushPayload, opts: { urgency?: "high" | "normal" | "low"; fcmPhonesReached?: number } = {}) {
  let all = listSubscriptions(userId);
  // Skip the Android app's web push only when FCM reached at least as many phones as there are app
  // subscriptions (subscriptions aren't tied to a device): a duplicate beats a phone getting nothing.
  const appSubs = all.filter((s) => s.source === "android-app").length;
  if (appSubs && (opts.fcmPhonesReached ?? 0) >= appSubs) all = all.filter((s) => s.source !== "android-app");
  // Endpoints saved before the allowlist existed are dropped, never contacted.
  for (const s of all) if (!isAllowedPushEndpoint(s.endpoint)) removeSubscription(s.endpoint);
  const subs = all.filter((s) => isAllowedPushEndpoint(s.endpoint));
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

export function inQuietHours(now = new Date(), userId?: string) {
  const p = getPreferences(userId);
  if (!p.quietHours.enabled) return false;
  return inWindow(localMinutes(now, p.timezone), p.quietHours.start, p.quietHours.end);
}

/** Outbox worker: deliver queued pushes, respecting quiet hours and read state. */
export async function deliverPendingPushes(now = new Date()) {
  const quietFor = new Map<string, boolean>();
  const quiet = (userId: string) => quietFor.get(userId) ?? quietFor.set(userId, inQuietHours(now, userId)).get(userId)!;
  let delivered = 0;
  for (const n of pendingPushes(now)) {
    if (n.readAt || n.dismissedAt || n.actedAt) {
      setPushState(n.id, "suppressed");
      continue;
    }
    const cat = NOTIFICATION_CATEGORIES.find((c) => c.id === (n.category as NotificationCategory));
    if (quiet(n.userId) && !(cat?.bypassQuietHours || n.severity === "critical")) continue; // hold until quiet hours end
    // Claim (conditional update) so the worker and the standalone dispatcher never send the same row twice.
    if (!claimPush(n.id, now)) continue;
    const payload: PushPayload = { id: n.id, title: n.title, body: n.body, url: n.deepLink, tag: n.dedupeKey ?? n.id, severity: n.severity };
    if (n.category === "ai_report" && (n.deepLink.startsWith("/inbox?") || n.deepLink.includes("view=inbox")))
      payload.actions = [
        { action: "open", title: "Open report" },
        { action: "file", title: "File it" },
      ];
    const urgency = n.severity === "critical" || n.category === "hermes_input" ? "high" : "normal";
    // Paired phones (FCM) first, then browsers (web push). Without Firebase (or when no phone has a
    // working token) the Android app's own web push subscription is the phone's channel; when FCM did
    // reach a phone, that app subscription is skipped so the phone doesn't buzz twice.
    const phone = await sendFcmToUser(n.userId, fcmData({ ...payload, category: n.category, unread: unreadActionableCount(n.userId) }), { urgency });
    const web = await sendToUser(n.userId, payload, { urgency, fcmPhonesReached: phone.failed ? 0 : phone.sent });
    const total = web.total + phone.total;
    const sent = web.sent + phone.sent;
    setPushState(n.id, total === 0 ? "suppressed" : sent > 0 ? "sent" : "failed");
    delivered += sent;
  }
  return delivered;
}

/**
 * What push channels exist for this user. The Android app shows its web push opt-in unless the
 * server can actually deliver FCM to a paired phone (Firebase configured and a token registered).
 */
export function pushCapabilities(userId: string) {
  const fcmConfigured = fcmStatus().configured;
  const phoneTokens = pushDevices(userId).length;
  const subs = listSubscriptions(userId).filter((s) => isAllowedPushEndpoint(s.endpoint));
  return {
    fcmConfigured,
    phoneTokens,
    nativePhonePush: fcmConfigured && phoneTokens > 0,
    webSubscriptions: subs.length,
    androidAppSubscriptions: subs.filter((s) => s.source === "android-app").length,
  };
}
