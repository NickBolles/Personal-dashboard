"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { ErrorNote, Field, useToast, SectionHeader } from "@/components/ui";
import { Badge, Button, Card, Spinner, inputCls } from "@/components/ui/legacy";
import { AGENT_SCOPES, AGENT_SCOPE_LABELS, DEFAULT_AGENT_SCOPES, type AgentScope, type AgentTokenView, type MintedAgentToken } from "@/lib/agent-access";
import { relativeTime } from "@/lib/time";

const KEY = ["settings", "agent-tokens"] as const;

/**
 * Settings → Agents → Agent access (docs/agent-tools.md): mint a scoped token for a Hermes profile
 * (shown once), list tokens with last use, revoke (confirmed). No scope maps to finance.* module capabilities.
 */
export function AgentAccessCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<{ tokens: AgentTokenView[] }>("/api/settings/agents/tokens") });
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [scopes, setScopes] = useState<AgentScope[]>(DEFAULT_AGENT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<MintedAgentToken | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const mint = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<MintedAgentToken>("/api/settings/agents/tokens", { name: name.trim(), profile: profile.trim().toLowerCase(), scopes });
      setMinted(r);
      setName("");
      setProfile("");
      setScopes(DEFAULT_AGENT_SCOPES);
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ["settings", "agents", "coordinators"] });
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (t: AgentTokenView) => {
    setBusy(true);
    try {
      await api.del(`/api/settings/agents/tokens/${encodeURIComponent(t.id)}`);
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ["settings", "agents", "coordinators"] });
      toast(`Revoked ${t.name}`, "ok");
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      toast("Copied", "ok");
    } catch {
      toast("Couldn't copy; select the token and copy it", "danger");
    }
  };

  const tokens = q.data?.tokens ?? [];
  const active = tokens.filter((t) => !t.revokedAt);
  return (
    <Card>
      <section aria-labelledby="agent-access-h" data-testid="agent-access">
        <SectionHeader label="Agent access" count={active.length} id="agent-access-h" />
        <p className="mb-2 text-[13px] text-muted">
          Lets a Hermes profile read and update your work through Jarvis MCP (<code>/api/mcp</code>). Its changes show &quot;by @profile&quot; and can be
          undone. Agents can&apos;t settle, archive, move or delete — they ask you. Areas excluded from AI are never available to agents. Credentials are never
          sent.
        </p>
        {minted ? (
          <div className="mb-3 rounded-[10px] border border-line p-2.5" role="status" data-testid="agent-token-once">
            <p className="text-[13px] font-semibold">Copy this token now — it won&apos;t be shown again.</p>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
              <input
                aria-label={`Agent token for ${minted.view.profile}`}
                readOnly
                className={`${inputCls} min-w-0 flex-1 font-mono text-[12px]`}
                value={minted.token}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button type="button" size="sm" onClick={() => void copy()}>
                Copy
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setMinted(null)}>
                Done
              </Button>
            </div>
          </div>
        ) : null}
        {q.isPending ? (
          <Spinner label="Loading agent tokens…" />
        ) : q.error ? (
          <ErrorNote error={q.error} retry={() => q.refetch()} />
        ) : tokens.length ? (
          <ul className="mb-3 space-y-2" aria-label="Agent tokens">
            {tokens.map((t) => (
              <li key={t.id} className="min-w-0 rounded-[10px] border border-line p-2.5 text-[13px]" data-testid="agent-token-row">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{t.name}</span>
                  <span className="jv-agent-chip">@{t.profile}</span>
                  {t.revokedAt ? <Badge tone="neutral">Revoked</Badge> : null}
                  <span className="font-mono text-xs text-muted">…{t.hint}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{t.scopes.map((s) => AGENT_SCOPE_LABELS[s].label).join(" · ")}</p>
                <p className="mt-0.5 text-xs text-muted" data-dynamic>
                  Created {relativeTime(t.createdAt)} · {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt)}` : "never used"}
                </p>
                {!t.revokedAt ? (
                  confirm === t.id ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span>Revoke {t.name}? The agent loses access at once.</span>
                      <Button type="button" size="sm" variant="danger" busy={busy} onClick={() => void revoke(t)}>
                        Revoke
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-1.5">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(t.id)} aria-label={`Revoke ${t.name}`}>
                        Revoke…
                      </Button>
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-[13px] text-muted">No agent tokens yet.</p>
        )}
        <form className="grid grid-cols-1 gap-2 sm:grid-cols-2" onSubmit={mint} aria-label="Give an agent access">
          <Field id="at-name" label="Name">
            <input id="at-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Chief of staff" maxLength={60} />
          </Field>
          <Field id="at-profile" label="Hermes profile">
            <input
              id="at-profile"
              className={inputCls}
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder="chiefofstaff"
              maxLength={32}
            />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-[13px] font-semibold">Scopes</legend>
            <div className="grid grid-cols-1 gap-1">
              {AGENT_SCOPES.map((s) => (
                <label key={s} className="tap flex items-start gap-2.5 rounded-[10px] px-1 py-1 text-[14px] hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                    checked={scopes.includes(s)}
                    onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                  />
                  <span className="min-w-0">
                    <span className="font-semibold">{AGENT_SCOPE_LABELS[s].label}</span>
                    <span className="block text-[13px] text-muted">{AGENT_SCOPE_LABELS[s].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !profile.trim() || !scopes.length}>
              Create token
            </Button>
          </div>
        </form>
      </section>
    </Card>
  );
}
