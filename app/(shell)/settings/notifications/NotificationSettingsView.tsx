"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { NOTIFICATION_CATEGORIES } from "@/lib/contracts";
import { PushControls, QuietHours, usePreferences } from "@/components/NotificationSetup";
import { Badge, Card, PageHeader, useToast } from "@/components/ui";

export function NotificationSettingsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const prefs = usePreferences();
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put("/api/settings", body),
    onMutate: (body) => {
      // Optimistic: reflect the toggle immediately, roll back on error.
      const prev = qc.getQueryData(["preferences"]);
      if (body.notificationCategories) {
        qc.setQueryData(["preferences"], (p: Record<string, unknown> | undefined) =>
          p ? { ...p, notificationCategories: { ...(p.notificationCategories as object), ...(body.notificationCategories as object) } } : p,
        );
      }
      return { prev };
    },
    onError: (e, _b, ctx) => {
      if (ctx?.prev) qc.setQueryData(["preferences"], ctx.prev);
      toast((e as Error).message, "danger");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["preferences"] }),
  });
  const cats = prefs.data?.notificationCategories ?? {};
  // Local, synchronous toggle state so the checkbox responds instantly; the server copy catches up.
  const [local, setLocal] = useState<Record<string, boolean>>({});
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader title="Notifications" subtitle="Every alert lands in the Alerts inbox. Push is an extra delivery channel." />
      <Card>
        <h2 className="mb-3 font-semibold">Push on this device</h2>
        <PushControls />
      </Card>
      <Card>
        <QuietHours />
      </Card>
      <Card>
        <h2 className="mb-1 font-semibold">What gets pushed</h2>
        <p className="mb-3 text-sm text-muted">Categories that are off still appear in the inbox.</p>
        <ul className="divide-y divide-line">
          {NOTIFICATION_CATEGORIES.map((c) => {
            const on = local[c.id] ?? cats[c.id]?.push ?? c.defaultPush;
            return (
              <li key={c.id} className="py-3">
                <label className="flex min-h-11 items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5"
                    checked={on}
                    onChange={(e) => {
                      const push = e.target.checked;
                      setLocal((l) => ({ ...l, [c.id]: push }));
                      m.mutate({ notificationCategories: { [c.id]: { push } } }, { onError: () => setLocal((l) => ({ ...l, [c.id]: !push })) });
                    }}
                  />
                  <span>
                    <span className="font-medium">{c.label}</span> {c.bypassQuietHours ? <Badge tone="warn">Ignores quiet hours</Badge> : null}
                    <span className="block text-sm text-muted">{c.description}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </Card>
      {prefs.data ? (
        <Card>
          <label htmlFor="fail-min" className="font-semibold">
            Alert when a source has been failing for
          </label>
          <div className="mt-2 flex items-center gap-2">
            <input
              id="fail-min"
              type="number"
              min={5}
              max={1440}
              className="min-h-12 w-28 rounded-[10px] border border-line-strong bg-surface px-3"
              defaultValue={prefs.data.integrationFailureAlertMinutes}
              onBlur={(e) => m.mutate({ integrationFailureAlertMinutes: Number(e.target.value) })}
            />
            <span className="text-sm text-muted">minutes</span>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
