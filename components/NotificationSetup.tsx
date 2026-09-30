"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { currentSubscription, disablePush, enablePush, pushSupport, type PushSupport } from "@/lib/client/push";
import { Badge, Button, useToast } from "@/components/ui";

export function PushControls() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [support, setSupport] = useState<PushSupport>("unsupported");
  const [subscribed, setSubscribed] = useState<boolean>();
  const [perm, setPerm] = useState<string>("default");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSupport(pushSupport());
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
    currentSubscription().then((s) => setSubscribed(Boolean(s)));
  }, []);

  const test = useMutation({
    mutationFn: () => api.post<{ subscriptions: number; delivered: number; quietHours: boolean }>("/api/notifications/test"),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      if (!r.subscriptions) toast("Test alert added to your inbox. Enable push on this device to also get it on your phone.", "warn");
      else if (r.delivered) toast(`Test sent to ${r.delivered} device${r.delivered > 1 ? "s" : ""}. Check your notifications.`, "ok");
      else toast("Push delivery failed. The alert is in your inbox; try re-enabling push.", "danger");
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>This device:</span>
        {support === "supported" ? (
          subscribed ? (
            <Badge tone="ok">Push enabled</Badge>
          ) : perm === "denied" ? (
            <Badge tone="danger">Blocked in browser</Badge>
          ) : (
            <Badge>Push off</Badge>
          )
        ) : support === "insecure" ? (
          <Badge tone="warn">Needs HTTPS</Badge>
        ) : support === "needs-install" ? (
          <Badge tone="warn">Install the app first</Badge>
        ) : (
          <Badge tone="warn">Not supported in this browser</Badge>
        )}
      </div>
      {support === "insecure" ? (
        <p className="text-sm text-muted">Browsers only allow push (and app install) on HTTPS. Open Jarvis through its HTTPS address.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {support === "supported" && !subscribed ? (
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await enablePush();
                setSubscribed(true);
                setPerm("granted");
                toast("Push notifications enabled on this device", "ok");
              } catch (err) {
                toast((err as Error).message, "danger");
              } finally {
                setBusy(false);
              }
            }}
          >
            Enable push on this device
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
              setBusy(false);
            }}
          >
            Turn off on this device
          </Button>
        ) : null}
        <Button busy={test.isPending} onClick={() => test.mutate()}>
          Send a test alert
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
