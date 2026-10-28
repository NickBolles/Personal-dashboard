/**
 * Android app (TWA) notifications without Firebase: the app's own web push subscription is the
 * phone's channel until FCM really reaches the phone; then it is skipped so nothing arrives twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fcm = vi.hoisted(() => ({ configured: false, sent: 0 }));
vi.mock("web-push", () => ({ default: { sendNotification: vi.fn(async () => ({})), generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }) } }));
vi.mock("@/server/notifications/fcm", async (orig) => ({
  ...(await orig<typeof import("@/server/notifications/fcm")>()),
  fcmStatus: () => ({ configured: fcm.configured, clientConfig: fcm.configured, serviceAccount: fcm.configured, projectMismatch: false, fromEnv: false }),
  sendFcmToUser: vi.fn(async () => ({ sent: fcm.sent, failed: 0, total: fcm.sent })),
}));

import webpush from "web-push";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { updatePreferences } from "@/server/settings";
import { notify } from "@/server/notifications";
import { createPairingCode, redeemPairingCode, deviceFromToken, updateDevice } from "@/server/devices";
import { deliverPendingPushes, listSubscriptions, pushCapabilities } from "@/server/notifications/push";
import * as capsRoute from "@/app/api/push/capabilities/route";
import * as subscribeRoute from "@/app/api/push/subscribe/route";

let owner: string;
const phoneSub = { endpoint: "https://fcm.googleapis.com/fcm/send/phone-twa", keys: { p256dh: "p", auth: "a" } };
const laptopSub = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/laptop", keys: { p256dh: "p", auth: "a" } };

type H = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
function call(handler: unknown, method = "GET", body?: unknown) {
  return (handler as H)(
    new NextRequest("http://jarvis.test/api/push/x", {
      method,
      headers: { cookie: `jarvis_session=${createSession(owner).token}`, "x-jarvis-csrf": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({}) },
  );
}

const endpointsSent = () => vi.mocked(webpush.sendNotification).mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);

function alert(key: string) {
  notify(
    { type: "t", category: "hermes_input", severity: "normal", title: "Needs you", body: "b", source: "jarvis", deepLink: "/alerts", dedupeKey: key },
    owner,
  );
}

beforeEach(() => {
  __setTestDatabase();
  fcm.configured = false;
  fcm.sent = 0;
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  updatePreferences({ quietHours: { enabled: false } }, owner);
});
afterEach(() => vi.clearAllMocks());

describe("push capabilities", () => {
  it("reports FCM not configured and counts the app's web push subscription", async () => {
    expect((await call(subscribeRoute.POST, "POST", { ...phoneSub, source: "android-app" })).status).toBe(200);
    expect((await call(subscribeRoute.POST, "POST", laptopSub)).status).toBe(200);
    const res = await call(capsRoute.GET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fcmConfigured: false, phoneTokens: 0, nativePhonePush: false, webSubscriptions: 2, androidAppSubscriptions: 1 });
    expect(listSubscriptions(owner).find((s) => s.endpoint === laptopSub.endpoint)!.source).toBe("browser");
  });

  it("native phone push needs both Firebase config and a registered phone token", async () => {
    fcm.configured = true;
    expect((await pushCapabilities(owner)).nativePhonePush).toBe(false);
    const { token } = redeemPairingCode(createPairingCode(owner).code, { name: "Pixel" });
    updateDevice(deviceFromToken(token)!.id, { pushToken: "fcm-token-0001" });
    expect(await pushCapabilities(owner)).toMatchObject({ fcmConfigured: true, phoneTokens: 1, nativePhonePush: true });
  });

  it("rejects an unknown subscription source", async () => {
    expect((await call(subscribeRoute.POST, "POST", { ...phoneSub, source: "other" })).status).toBe(400);
  });
});

describe("delivery dedupe", () => {
  it("without Firebase the Android app's web push subscription gets the alert", async () => {
    await call(subscribeRoute.POST, "POST", { ...phoneSub, source: "android-app" });
    await call(subscribeRoute.POST, "POST", laptopSub);
    alert("fallback-1");
    expect(await deliverPendingPushes()).toBe(2);
    expect(endpointsSent().sort()).toEqual([phoneSub.endpoint, laptopSub.endpoint].sort());
  });

  it("when FCM reached the phone, the app's web push subscription is skipped (browsers still get it)", async () => {
    fcm.configured = true;
    fcm.sent = 1;
    await call(subscribeRoute.POST, "POST", { ...phoneSub, source: "android-app" });
    await call(subscribeRoute.POST, "POST", laptopSub);
    alert("dedupe-1");
    expect(await deliverPendingPushes()).toBe(2);
    expect(endpointsSent()).toEqual([laptopSub.endpoint]);
  });

  it("a second app subscription keeps web push when FCM reached only one phone", async () => {
    fcm.configured = true;
    fcm.sent = 1;
    const otherPhone = { endpoint: "https://fcm.googleapis.com/fcm/send/phone-twa-2", keys: { p256dh: "p", auth: "a" } };
    await call(subscribeRoute.POST, "POST", { ...phoneSub, source: "android-app" });
    await call(subscribeRoute.POST, "POST", { ...otherPhone, source: "android-app" });
    alert("dedupe-2");
    await deliverPendingPushes();
    expect(endpointsSent().sort()).toEqual([phoneSub.endpoint, otherPhone.endpoint].sort());
  });
});
