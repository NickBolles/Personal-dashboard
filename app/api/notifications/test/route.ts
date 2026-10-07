import { api } from "@/server/http/api";
import { notify } from "@/server/notifications";
import { deliverPendingPushes, listSubscriptions } from "@/server/notifications/push";
import { pushDevices } from "@/server/devices";

/** Creates a real inbox item and pushes it immediately (bypasses quiet hours for the test). */
export const POST = api(async ({ user }) => {
  const created = notify(
    {
      type: "jarvis.test",
      category: "hermes_input",
      severity: "normal",
      title: "Test notification",
      body: "If you can read this on your phone, push works. Tap to open Alerts.",
      source: "jarvis",
      deepLink: "/alerts",
      dedupeKey: `test:${Date.now()}`,
    },
    user.id,
  );
  const subs = listSubscriptions(user.id).length;
  const { inQuietHours } = await import("@/server/notifications/push");
  const quiet = inQuietHours(new Date(), user.id);
  const delivered = await deliverPendingPushes(quiet ? new Date(0) : new Date());
  return { ok: true, id: created?.id, subscriptions: subs, phones: pushDevices(user.id).length, delivered, quietHours: quiet };
});
