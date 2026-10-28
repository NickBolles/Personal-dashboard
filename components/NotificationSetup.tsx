"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { currentSubscription, disablePush, enablePush, pushSupport, type PushSupport } from "@/lib/client/push";
import { isAndroidWrapper } from "@/lib/client/wrapper";
import { Badge, Button, useToast } from "@/components/ui";

export type PushCapabilities = {
  fcmConfigured: boolean;
  phoneTokens: number;
  nativePhonePush: boolean;
  webSubscriptions: number;
  androidAppSubscriptions: number;
};

export function PushControls() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [support, setSupport] = useState<PushSupport>("unsupported");
  const [subscribed, setSubscribed] = useState<boolean>();
  const [perm, setPerm] = useState<string>("default");
  const [busy, setBusy] = useState(false);
  // Inside the Android app (a Trusted Web Activity) Chrome handles notification permission and web push.
  const [inApp, setInApp] = useState(false);
  const caps = useQuery({ queryKey: ["push-capabilities"], queryFn: () => api.get<PushCapabilities>("/api/push/capabilities") });
  // Only hide web push in the app when the server can really reach this phone over FCM.
  const nativePush = inApp && Boolean(caps.data?.nativePhonePush);

  useEffect(() => {
    setInApp(isAndroidWrapper());
    setSupport(pushSupport());
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
    currentSubscription().then((s) => setSubscribed(Boolean(s)));
  }, []);

  const test = useMutation({
    mutationFn: () => api.post<{ subscriptions: number; phones: number; delivered: number; quietHours: boolean }>("/api/notifications/test"),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      if (!r.subscriptions && !(caps.data?.nativePhonePush ?? false))
        toast("Test alert added to your inbox. Enable notifications on this device to also get it on your phone.", "warn");
      else if (r.delivered) toast(`Test sent to ${r.delivered} device${r.delivered > 1 ? "s" : ""}. Check your notifications.`, "ok");
      else toast("Push delivery failed. The alert is in your inbox; try enabling notifications again.", "danger");
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  const webPushLabel = subscribed ? "web push on" : perm === "denied" ? "web push blocked" : "web push off";
  const fcmLabel = caps.data
    ? caps.data.fcmConfigured
      ? caps.data.phoneTokens
        ? "app push (FCM) on"
        : "FCM: no phone registered"
      : "FCM not configured"
    : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="push-status">
        <span>{inApp ? "This phone:" : "This device:"}</span>
        {nativePush && !subscribed ? (
          <Badge tone="ok">Notifications from the Jarvis app</Badge>
        ) : support === "supported" ? (
          <Badge tone={subscribed ? "ok" : perm === "denied" ? "danger" : undefined}>{webPushLabel}</Badge>
        ) : support === "insecure" ? (
          <Badge tone="warn">Needs HTTPS</Badge>
        ) : support === "needs-install" ? (
          <Badge tone="warn">Install the app first</Badge>
        ) : (
          <Badge tone="warn">Not supported in this browser</Badge>
        )}
        {inApp && fcmLabel ? (
          <span data-testid="fcm-status">
            <Badge tone={nativePush ? "ok" : undefined}>{fcmLabel}</Badge>
          </span>
        ) : null}
      </div>
      {nativePush ? (
        <p className="text-sm text-muted" data-testid="android-app-push-note">
          This phone gets notifications from the Jarvis app, so web push stays off here and nothing arrives twice.
        </p>
      ) : inApp ? (
        <p className="text-sm text-muted" data-testid="android-app-webpush-note">
          The Jarvis app delivers notifications through Chrome until Firebase is set up. Enable them here; Android asks once.
        </p>
      ) : null}
      {perm === "denied" && support === "supported" && !subscribed ? (
        <p className="text-sm text-muted">Notifications are blocked. Allow them for this site in Chrome (site settings → Notifications), then try again.</p>
      ) : null}
      {support === "insecure" && !nativePush ? (
        <p className="text-sm text-muted">Browsers only allow push (and app install) on HTTPS. Open Jarvis through its HTTPS address.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {support === "supported" && !subscribed && !nativePush ? (
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await enablePush({ androidApp: inApp });
                setSubscribed(true);
                setPerm("granted");
                qc.invalidateQueries({ queryKey: ["push-capabilities"] });
                toast("Notifications enabled on this device", "ok");
              } catch (err) {
                toast((err as Error).message, "danger");
              } finally {
                setBusy(false);
              }
            }}
          >
            Enable notifications
          </Button>
        ) : null}
        {subscribed ? (
          <Button
            variant="ghost"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await disablePush();
              setSubscribed(false);
              qc.invalidateQueries({ queryKey: ["push-capabilities"] });
              setBusy(false);
            }}
          >
            Turn off on this device
          </Button>
        ) : null}
        <Button busy={test.isPending} onClick={() => test.mutate()}>
          Send test notification
        </Button>
      </div>
    </div>
  );
}

type Prefs = {
  quietHours: { enabled: boolean; start: string; end: string };
  notificationCategories: Record<string, { push: boolean }>;
  integrationFailureAlertMinutes: number;
};

export function usePreferences() {
  return useQuery({ queryKey: ["preferences"], queryFn: () => api.get<Prefs & Record<string, unknown>>("/api/settings") });
}

export function QuietHours() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const prefs = usePreferences();
  const m = useMutation({
    mutationFn: (quietHours: Partial<Prefs["quietHours"]>) => api.put("/api/settings", { quietHours }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["preferences"] }),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const qh = prefs.data?.quietHours;
  if (!qh) return null;
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">Quiet hours</legend>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={qh.enabled} onChange={(e) => m.mutate({ enabled: e.target.checked })} />
        Hold non-critical pushes during quiet hours (they stay in your inbox)
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          <span className="block font-medium">From</span>
          <input
            type="time"
            className="min-h-12 rounded-[10px] border border-line-strong bg-surface px-3"
            value={qh.start}
            onChange={(e) => m.mutate({ start: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="block font-medium">Until</span>
          <input
            type="time"
            className="min-h-12 rounded-[10px] border border-line-strong bg-surface px-3"
            value={qh.end}
            onChange={(e) => m.mutate({ end: e.target.value })}
          />
        </label>
      </div>
    </fieldset>
  );
}
