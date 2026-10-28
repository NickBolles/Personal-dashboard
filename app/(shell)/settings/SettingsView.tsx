"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { clearAllLocal } from "@/lib/client/idb";
import { Button, Card, Field, Page, PageHeader, SectionLabel, inputCls, useToast } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { useAccess } from "@/components/access";
import { AssistantSettings } from "./AssistantSettings";
import { SharedConversations } from "./SharedConversations";
import { SmartSettings } from "./SmartSettings";

type Prefs = {
  displayName: string;
  timezone: string;
  refreshIntervalMinutes: number;
  hermes: { defaultModel?: string; defaultProvider?: string; showToolDetails: boolean };
};

export function SettingsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isAdmin, role, can } = useAccess();
  const minPass = role === "household" ? 4 : 6;
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
    ...(isAdmin
      ? [{ href: "/settings/connections", label: "Connections", desc: "Hermes, todos, Home Assistant, Skylight, Paperclip, Daily Compass, Finance, GitHub" }]
      : []),
    ...(isAdmin ? [{ href: "/settings/people", label: "People", desc: "Family members, the kitchen tablet, and what each can use" }] : []),
    ...(isAdmin ? [{ href: "/settings/configuration", label: "Configuration transfer", desc: "Password-encrypted integration import and export" }] : []),
    { href: "/settings/home", label: "Home priorities", desc: "What Home shows first, hidden items, saved dates, your feedback" },
    { href: "/settings/notifications", label: "Notifications", desc: "Push on this device, quiet hours, categories" },
    { href: "/settings/phones", label: "Phones", desc: "Pair the Jarvis Android app, phone notifications" },
    ...(isAdmin ? [{ href: "/settings/ai", label: "AI", desc: "Budget, models and capture triage for background AI actions" }] : []),
    ...(isAdmin ? [{ href: "/settings/activity", label: "Activity log", desc: "Audit trail of consequential actions" }] : []),
  ];

  return (
    <Page>
      <PageHeader title="Settings" />
      <div className="grid items-start gap-x-5 gap-y-4 md:grid-cols-[minmax(0,248px)_minmax(0,1fr)] lg:gap-x-6 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <nav aria-labelledby="settings-sections-h" className="md:sticky md:top-4">
          <SectionLabel id="settings-sections-h">Sections</SectionLabel>
          <ul className="card rows overflow-hidden p-0">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="flex min-h-14 items-center justify-between gap-2 px-3.5 py-2.5 hover:bg-surface-2 dense:min-h-0">
                  <span className="min-w-0">
                    <span className="block font-semibold">{l.label}</span>
                    <span className="block text-sm text-muted">{l.desc}</span>
                  </span>
                  <ChevronIcon className="h-4 w-4 shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-4">
          {form ? (
            <Card>
              <h2 className="eyebrow mb-3">Preferences</h2>
              <form
                className="grid items-start gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate(
                    isAdmin
                      ? {
                          displayName: form.displayName,
                          timezone: form.timezone,
                          refreshIntervalMinutes: Number(form.refreshIntervalMinutes),
                          hermes: form.hermes,
                        }
                      : { displayName: form.displayName },
                  );
                }}
              >
                <Field id="s-name" label="Your name">
                  <input id="s-name" className={inputCls} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
                </Field>
                {isAdmin ? (
                  <>
                    <Field id="s-tz" label="Timezone" hint="Used for due dates, check-in windows and quiet hours.">
                      <input id="s-tz" className={inputCls} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
                    </Field>
                    <Field id="s-model" label="Default Hermes model (optional)" hint="Only sent when set; otherwise Hermes uses its own default.">
                      <input
                        id="s-model"
                        className={inputCls}
                        value={form.hermes.defaultModel ?? ""}
                        onChange={(e) => setForm({ ...form, hermes: { ...form.hermes, defaultModel: e.target.value || undefined } })}
                      />
                    </Field>
                    <Field id="s-provider" label="Default Hermes provider (optional)">
                      <input
                        id="s-provider"
                        className={inputCls}
                        value={form.hermes.defaultProvider ?? ""}
                        onChange={(e) => setForm({ ...form, hermes: { ...form.hermes, defaultProvider: e.target.value || undefined } })}
                      />
                    </Field>
                  </>
                ) : null}
                <Button type="submit" variant="primary" busy={save.isPending} className="justify-self-start sm:col-span-2">
                  Save preferences
                </Button>
              </form>
            </Card>
          ) : null}

          {isAdmin ? <AssistantSettings /> : null}
          {can("hermes.chat") ? <SmartSettings /> : null}
          {can("hermes.chat") ? <SharedConversations /> : null}

          {me.data?.authMode === "local" ? (
            <Card>
              <h2 className="eyebrow mb-3">Security</h2>
              <form
                className="grid items-start gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  pass.mutate();
                }}
              >
                <Field id="p-cur" label="Current passcode">
                  <input id="p-cur" type="password" autoComplete="current-password" className={inputCls} value={cur} onChange={(e) => setCur(e.target.value)} />
                </Field>
                <Field
                  id="p-new"
                  label={role === "household" ? "New PIN or passcode" : "New passcode"}
                  hint={`${role === "household" ? "At least 4 digits, or 6 characters." : "At least 6 characters."} Changing it signs out every device.`}
                >
                  <input
                    id="p-new"
                    type="password"
                    minLength={minPass}
                    autoComplete="new-password"
                    className={inputCls}
                    value={nxt}
                    onChange={(e) => setNxt(e.target.value)}
                  />
                </Field>
                <Button type="submit" busy={pass.isPending} disabled={!cur || nxt.length < minPass} className="justify-self-start sm:col-span-2">
                  Change passcode
                </Button>
              </form>
            </Card>
          ) : (
            <Card>
              <h2 className="eyebrow">Security</h2>
              <p className="mt-1 text-sm text-muted">Sign-in is handled by your reverse proxy ({me.data?.user.via}).</p>
            </Card>
          )}

          <Card>
            <h2 className="eyebrow mb-3">This device</h2>
            <div className="flex flex-wrap gap-2">
              {isAdmin ? (
                <Button
                  onClick={async () => {
                    await api.put("/api/settings", { onboarding: { completedAt: null } }).catch(() => undefined);
                    window.location.href = "/onboarding?step=welcome";
                  }}
                >
                  Re-run setup
                </Button>
              ) : null}
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
                    await api.post("/api/auth/logout").catch(() => undefined);
                    // Shared devices: the next person must not see this person's cached pages or chats.
                    await clearAllLocal();
                    window.location.href = "/login";
                  }}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
