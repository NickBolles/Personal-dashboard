"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, Button, Card, ErrorNote, Field, PageHeader, Spinner, inputCls, useToast } from "@/components/ui";
import { SectionHeader } from "@/components/ui/kit";
import { KEY_ENV_PREFIX, suggestedKeyEnv, type AgentRoute, type AgentSettings } from "@/lib/agents";

type RouteStatus = AgentRoute & { effectiveBaseUrl: string | null; keyPresent: boolean; sharedKey?: boolean };
type View = { settings: AgentSettings; routes: RouteStatus[]; hermesConfigured: boolean };
type TestResult = { profile: string; served: boolean; authorized: boolean; message: string };

/**
 * Settings → Agents (admin): which Hermes profile answers in each area.
 * Hermes serves named profiles at `<Hermes URL>/p/<profile>` with their own key;
 * the key lives in the Jarvis secrets env file, and only its env var name is stored here.
 */
export function AgentsSettingsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["settings", "agents"], queryFn: () => api.get<View>("/api/settings/agents") });
  const [busy, setBusy] = useState(false);
  // optimistic toggle state while a save is in flight (controlled checkboxes would otherwise snap back until refetch)
  const [pending, setPending] = useState<Partial<AgentSettings>>({});
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [profile, setProfile] = useState("");
  const [keyEnv, setKeyEnv] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  if (q.isPending) return <Spinner label="Loading agent settings…" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const s = q.data.settings;
  const save = async (patch: Partial<AgentSettings>, ok = "Saved") => {
    setBusy(true);
    setPending(patch);
    try {
      await api.put("/api/settings/agents", patch);
      await qc.invalidateQueries({ queryKey: ["settings", "agents"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast(ok, "ok");
      return true;
    } catch (e) {
      toast((e as Error).message, "danger");
      return false;
    } finally {
      setPending({});
      setBusy(false);
    }
  };
  const test = async (p: string) => {
    try {
      const r = await api.post<TestResult>("/api/settings/agents/test", { profile: p });
      setTests((t) => ({ ...t, [p]: r }));
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  const routes = (list: RouteStatus[]): AgentRoute[] => list.map(({ profile, keyEnv, baseUrl }) => ({ profile, keyEnv, baseUrl }));
  const p = profile.trim().toLowerCase();
  return (
    <div className="space-y-3">
      <PageHeader title="Agents" subtitle="Which Hermes profile answers in each area. Set an area's agent in its Area settings." />
      <Card>
        <div className="space-y-2">
          <label className="tap flex items-start gap-2 text-[14px]">
            <input
              type="checkbox"
              className="mt-1"
              checked={pending.routing ?? s.routing}
              disabled={busy}
              onChange={(e) => void save({ routing: e.target.checked })}
            />
            <span>
              <span className="font-semibold">Route areas to their Hermes profile</span>
              <span className="block text-[13px] text-muted">
                New chats, AI actions and AI jobs under an area run on its profile (inherited from parent items). Off: the profile name is only sent as a hint
                to the default profile.
              </span>
            </span>
          </label>
          <label className="tap flex items-start gap-2 text-[14px]">
            <input
              type="checkbox"
              className="mt-1"
              checked={pending.aguiStream ?? s.aguiStream}
              disabled={busy}
              onChange={(e) => void save({ aguiStream: e.target.checked })}
            />
            <span>
              <span className="font-semibold">Stream runs as AG-UI events</span>
              <span className="block text-[13px] text-muted">
                Chat runs reach the browser in the AG-UI protocol (preview for coordinators). The phone app is unaffected.
              </span>
            </span>
          </label>
          {!q.data.hermesConfigured ? <p className="text-[13px] text-danger">Hermes isn&apos;t configured yet (Settings → Connections).</p> : null}
        </div>
      </Card>
      <Card>
        <SectionHeader label="Profile routes" count={q.data.routes.length} />
        <p className="mb-2 text-[13px] text-muted">
          Each profile needs its own Hermes API key. Put it in the Jarvis secrets env file as the variable below (it never goes in the database), then recreate
          the container.
        </p>
        {q.data.routes.length ? (
          <ul className="mb-3 divide-y divide-line rounded-[10px] border border-line" aria-label="Profile routes">
            {q.data.routes.map((r) => {
              const t = tests[r.profile];
              return (
                <li key={r.profile} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid={`agent-route-${r.profile}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      <span aria-hidden="true">✦ </span>
                      {r.profile}
                    </span>
                    <span className="block truncate text-[12.5px] text-muted" data-dynamic>
                      {r.effectiveBaseUrl ?? "—"} · key {r.keyEnv ?? "main Hermes key"}
                    </span>
                    {t ? (
                      <span className={`block text-[12.5px] ${t.authorized ? "text-ok" : "text-danger"}`} role="status">
                        {t.authorized ? "Connected" : t.served ? `Served, but the key was refused: ${t.message}` : `Not reachable: ${t.message}`}
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={r.keyPresent ? "ok" : "warn"}>{r.keyPresent ? "Key set" : "Key missing"}</Badge>
                  <Button size="sm" variant="secondary" onClick={() => void test(r.profile)} aria-label={`Test ${r.profile}`}>
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Remove ${r.profile}`}
                    onClick={() => void save({ routes: routes(q.data.routes.filter((x) => x.profile !== r.profile)) }, "Route removed")}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mb-3 text-[13px] text-muted">No profile routes yet. Everything runs on the default Hermes profile.</p>
        )}
        <form
          className="grid gap-2 sm:grid-cols-3"
          aria-label="Add a profile route"
          onSubmit={async (e) => {
            e.preventDefault();
            const route: AgentRoute = { profile: p, keyEnv: keyEnv.trim() || null, baseUrl: baseUrl.trim() || null };
            if (await save({ routes: [...routes(q.data.routes.filter((x) => x.profile !== p)), route] }, `Route for ${p} saved`)) {
              setProfile("");
              setKeyEnv("");
              setBaseUrl("");
            }
          }}
        >
          <Field id="ag-profile" label="Hermes profile">
            <input
              id="ag-profile"
              className={inputCls}
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder="momentumchief"
              required
              maxLength={64}
            />
          </Field>
          <Field id="ag-key" label="Key env var (optional)" hint={`Starts with ${KEY_ENV_PREFIX}. Blank: reuse the main Hermes key`}>
            <input
              id="ag-key"
              className={inputCls}
              value={keyEnv}
              onChange={(e) => setKeyEnv(e.target.value.toUpperCase())}
              placeholder={p ? suggestedKeyEnv(p) : `${KEY_ENV_PREFIX}MOMENTUMCHIEF`}
              maxLength={90}
            />
          </Field>
          <Field id="ag-url" label="Base URL (optional)" hint="Blank: the Hermes connection URL + /p/<profile>">
            <input id="ag-url" className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" maxLength={300} />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" variant="primary" disabled={busy || !p}>
              Save route
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
