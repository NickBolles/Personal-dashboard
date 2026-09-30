"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { clearAllLocal } from "@/lib/client/idb";
import { Button, Card, Field, PageHeader, inputCls, useToast } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";

type Prefs = {
  displayName: string;
  timezone: string;
  refreshIntervalMinutes: number;
  hermes: { defaultModel?: string; defaultProvider?: string; showToolDetails: boolean };
};

export function SettingsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: () => api.get<Prefs>("/api/settings") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ authMode: string; user: { name: string; via: string } }>("/api/auth/me") });
  const [form, setForm] = useState<Prefs>();
  useEffect(() => {
    if (prefs.data) setForm(prefs.data);
  }, [prefs.data]);
  const save = useMutation({
    mutationFn: (p: Partial<Prefs>) => api.put("/api/settings", p),
    onSuccess: () => {
      toast("Settings saved", "ok");
      qc.invalidateQueries({ queryKey: ["preferences"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  const [cur, setCur] = useState("");
  const [nxt, setNxt] = useState("");
  const pass = useMutation({
    mutationFn: () => api.post("/api/auth/passcode", { current: cur, next: nxt }),
    onSuccess: () => {
      toast("Passcode changed. Signing out other sessions…", "ok");
      setTimeout(() => (window.location.href = "/login"), 1200);
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  const links = [
    { href: "/settings/connections", label: "Connections", desc: "Hermes, todos, Home Assistant, Skylight, Paperclip, Daily Compass" },
    { href: "/settings/notifications", label: "Notifications", desc: "Push on this device, quiet hours, categories" },
    { href: "/settings/activity", label: "Activity log", desc: "Audit trail of consequential actions" },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader title="Settings" />
      <ul className="card divide-y divide-line">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex min-h-16 items-center justify-between gap-2 p-4 hover:bg-surface-2">
              <span>
                <span className="block font-medium">{l.label}</span>
                <span className="text-sm text-muted">{l.desc}</span>
              </span>
              <ChevronIcon className="h-5 w-5 text-muted" />
            </Link>
          </li>
        ))}
      </ul>

      {form ? (
        <Card>
          <h2 className="mb-3 font-semibold">Preferences</h2>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({
                displayName: form.displayName,
                timezone: form.timezone,
                refreshIntervalMinutes: Number(form.refreshIntervalMinutes),
                hermes: form.hermes,
              });
            }}
          >
            <Field id="s-name" label="Your name">
              <input id="s-name" className={inputCls} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </Field>
            <Field id="s-tz" label="Timezone" hint="Used for due dates, check-in windows and quiet hours.">
              <input id="s-tz" className={inputCls} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            </Field>
            <Field id="s-model" label="Default Hermes model (optional)" hint="Only sent when set; otherwise Hermes uses its own default.">
              <input id="s-model" className={inputCls} value={form.hermes.defaultModel ?? ""} onChange={(e) => setForm({ ...form, hermes: { ...form.hermes, defaultModel: e.target.value || undefined } })} />
            </Field>
            <Field id="s-provider" label="Default Hermes provider (optional)">
              <input id="s-provider" className={inputCls} value={form.hermes.defaultProvider ?? ""} onChange={(e) => setForm({ ...form, hermes: { ...form.hermes, defaultProvider: e.target.value || undefined } })} />
            </Field>
            <Button type="submit" variant="primary" busy={save.isPending}>
              Save preferences
            </Button>
          </form>
        </Card>
      ) : null}

      {me.data?.authMode === "local" ? (
        <Card>
          <h2 className="mb-3 font-semibold">Security</h2>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              pass.mutate();
            }}
          >
            <Field id="p-cur" label="Current passcode">
              <input id="p-cur" type="password" autoComplete="current-password" className={inputCls} value={cur} onChange={(e) => setCur(e.target.value)} />
            </Field>
            <Field id="p-new" label="New passcode" hint="At least 6 characters. Changing it signs out every device.">
              <input id="p-new" type="password" minLength={6} autoComplete="new-password" className={inputCls} value={nxt} onChange={(e) => setNxt(e.target.value)} />
            </Field>
            <Button type="submit" busy={pass.isPending} disabled={!cur || nxt.length < 6}>
              Change passcode
            </Button>
          </form>
        </Card>
      ) : (
        <Card>
          <h2 className="font-semibold">Security</h2>
          <p className="mt-1 text-sm text-muted">Sign-in is handled by your reverse proxy ({me.data?.user.via}).</p>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 font-semibold">This device</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={async () => {
              await api.put("/api/settings", { onboarding: { completedAt: null } }).catch(() => undefined);
              window.location.href = "/onboarding?step=welcome";
            }}
          >
            Re-run setup
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await clearAllLocal();
              toast("Cleared drafts and cached data on this device", "ok");
            }}
          >
            Clear local cache
          </Button>
          {me.data?.authMode === "local" ? (
            <Button
              variant="danger"
              onClick={async () => {
                await api.post("/api/auth/logout");
                window.location.href = "/login";
              }}
            >
              Sign out
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
