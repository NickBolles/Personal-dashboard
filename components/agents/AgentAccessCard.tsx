"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import {
  AnchoredMenu,
  Button,
  Card,
  Checkbox,
  ErrorNote,
  Field,
  Input,
  KSpinner,
  MenuButton,
  Pill,
  useAnchoredMenu,
  useToast,
  SectionHeader,
} from "@/components/ui";
import {
  AGENT_SCOPES,
  AGENT_SCOPE_LABELS,
  DEFAULT_AGENT_SCOPES,
  RISKY_AGENT_SCOPES,
  groupByProfile,
  normaliseScopes,
  type AgentScope,
  type AgentTokenView,
  type MintedAgentToken,
} from "@/lib/agent-access";
import { relativeTime } from "@/lib/time";
import { EditScopesDialog } from "./EditScopesDialog";

const KEY = ["settings", "agent-tokens"] as const;

function activeLabel(rows: AgentTokenView[]): string {
  const active = rows.filter((t) => !t.revokedAt).length;
  const revoked = rows.length - active;
  return [active ? `${active} active` : null, revoked ? `${revoked} revoked` : null].filter(Boolean).join(" · ");
}

/**
 * Settings → Agents → Agent access (docs/agent-tools.md): mint a scoped token for a Hermes profile
 * (shown once), list tokens grouped by profile with last use, edit scopes (same token, confirmed diff) or revoke
 * (confirmed) from the row's ⋯ menu. No scope maps to finance.* module capabilities.
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
  const [editing, setEditing] = useState<AgentTokenView | null>(null);
  /** The last saved scope edit, kept so it can be undone (restores the previous scopes on the same token). */
  const [lastEdit, setLastEdit] = useState<{ id: string; name: string; before: AgentScope[]; undone?: boolean } | null>(null);

  const putScopes = async (id: string, next: AgentScope[]) => {
    await api.patch(`/api/settings/agents/tokens/${encodeURIComponent(id)}`, { scopes: next });
    await qc.invalidateQueries({ queryKey: KEY });
    await qc.invalidateQueries({ queryKey: ["settings", "agents", "coordinators"] });
  };
  const saveScopes = async (t: AgentTokenView, next: AgentScope[]) => {
    try {
      await putScopes(t.id, next);
      setEditing(null);
      setLastEdit({ id: t.id, name: t.name, before: normaliseScopes(t.scopes) });
    } catch (err) {
      toast((err as Error).message, "danger");
    }
  };
  const undoScopes = async () => {
    if (!lastEdit || lastEdit.undone) return;
    setBusy(true);
    try {
      await putScopes(lastEdit.id, lastEdit.before);
      setLastEdit({ ...lastEdit, undone: true });
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
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
        <p className="mb-2 text-sm text-muted">
          Lets a Hermes profile read and update your work through Atlas MCP (<code>/api/mcp</code>). Its changes show &quot;by @profile&quot; and can be undone.
          Agents can&apos;t settle, archive, move or delete — they ask you. Areas excluded from AI are never available to agents. Credentials are never sent.
        </p>
        {minted ? (
          <div className="mb-3 rounded-lg border border-line p-2.5" role="status" data-testid="agent-token-once">
            <p className="text-sm font-semibold">Copy this token now — it won&apos;t be shown again.</p>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
              <Input
                aria-label={`Agent token for ${minted.view.profile}`}
                readOnly
                className="min-w-0 flex-1 font-mono text-xs"
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
        {lastEdit ? (
          <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm" data-testid="agent-scopes-saved">
            <span role="status" className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {lastEdit.undone ? `Scopes for ${lastEdit.name} restored.` : `Scopes saved for ${lastEdit.name}.`}
            </span>
            {lastEdit.undone ? null : (
              <Button type="button" size="sm" variant="ghost" loading={busy} onClick={() => void undoScopes()}>
                Undo
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => setLastEdit(null)}>
              Dismiss
            </Button>
          </div>
        ) : null}
        {q.isPending ? (
          <span role="status">
            <KSpinner />
            Loading agent tokens…
          </span>
        ) : q.error ? (
          <ErrorNote error={q.error} retry={() => q.refetch()} />
        ) : tokens.length ? (
          <ul className="mb-3 space-y-3" aria-label="Agent tokens">
            {groupByProfile(tokens).map(([profile, rows]) => (
              <li key={profile} className="min-w-0" data-testid="agent-token-group">
                <h3 className="mb-1 flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted">
                  <span className="jv-agent-chip text-sm">@{profile}</span>
                  <span>{activeLabel(rows)}</span>
                </h3>
                <ul className="divide-y divide-line rounded-lg border border-line" aria-label={`Tokens for @${profile}`}>
                  {rows.map((t) => (
                    <TokenRow
                      key={t.id}
                      t={t}
                      busy={busy}
                      confirming={confirm === t.id}
                      onAskRevoke={() => setConfirm(t.id)}
                      onCancelRevoke={() => setConfirm(null)}
                      onRevoke={() => void revoke(t)}
                      onEdit={() => setEditing(t)}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-sm text-muted">No agent tokens yet.</p>
        )}
        <form className="grid grid-cols-1 gap-2 sm:grid-cols-2" onSubmit={mint} aria-label="Give an agent access">
          <Field id="at-name" label="Name">
            <Input id="at-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Chief of staff" maxLength={60} />
          </Field>
          <Field id="at-profile" label="Hermes profile">
            <Input id="at-profile" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="chiefofstaff" maxLength={32} />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-semibold">Scopes</legend>
            <div className="grid grid-cols-1 gap-1">
              {AGENT_SCOPES.map((s) => (
                <Checkbox
                  key={s}
                  checked={scopes.includes(s)}
                  onChange={(checked) => setScopes((cur) => (checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                  label={
                    <span className="min-w-0">
                      <span className="font-semibold">{AGENT_SCOPE_LABELS[s].label}</span>
                      {RISKY_AGENT_SCOPES[s] ? (
                        <>
                          {" "}
                          <Pill tone="wn">Spends budget</Pill>
                        </>
                      ) : null}
                      <span className="block text-sm text-muted">{AGENT_SCOPE_LABELS[s].hint}</span>
                    </span>
                  }
                />
              ))}
            </div>
          </fieldset>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !profile.trim() || !scopes.length}>
              Create token
            </Button>
          </div>
        </form>
        {editing ? <EditScopesDialog token={editing} onClose={() => setEditing(null)} onSave={(next) => saveScopes(editing, next)} /> : null}
      </section>
    </Card>
  );
}

/**
 * One token: name · …last4 · state on the first line, scopes as chips (risky ones amber), created / last used.
 * Actions live in the row's ⋯ menu (Edit scopes…, Revoke…); revoking still asks inline.
 */
function TokenRow({
  t,
  busy,
  confirming,
  onAskRevoke,
  onCancelRevoke,
  onRevoke,
  onEdit,
}: {
  t: AgentTokenView;
  busy: boolean;
  confirming: boolean;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onRevoke: () => void;
  onEdit: () => void;
}) {
  const live = !t.revokedAt;
  const menu = useAnchoredMenu({ enabled: live });
  const { surfaceProps } = menu;
  const scopes = normaliseScopes(t.scopes);
  return (
    <li className={`min-w-0 p-2.5 text-sm ${live ? "" : "opacity-70"}`} data-testid="agent-token-row" {...surfaceProps}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{t.name}</span>
            <span className="font-mono text-xs text-muted">…{t.hint}</span>
            {live ? null : <Pill tone="neutral">Revoked</Pill>}
          </div>
          <ul className="mt-1 flex min-w-0 flex-wrap gap-1" aria-label={`Scopes for ${t.name}`}>
            {scopes.map((s) => (
              <li key={s} className="min-w-0">
                <Pill tone={RISKY_AGENT_SCOPES[s] ? "wn" : "neutral"}>{AGENT_SCOPE_LABELS[s].label}</Pill>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted" data-dynamic>
            Created {relativeTime(t.createdAt)} · {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt)}` : "never used"}
            {t.revokedAt ? ` · revoked ${relativeTime(t.revokedAt)}` : ""}
          </p>
        </div>
        {live ? <MenuButton menu={menu} label={`Actions for ${t.name}`} className="shrink-0" /> : null}
      </div>
      {live && confirming ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span>Revoke {t.name}? The agent loses access at once.</span>
          <Button type="button" size="sm" variant="danger" loading={busy} onClick={onRevoke}>
            Revoke
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancelRevoke}>
            Cancel
          </Button>
        </div>
      ) : null}
      {live ? (
        <AnchoredMenu
          menu={menu}
          label={`Actions for ${t.name}`}
          items={[
            { label: "Edit scopes…", onSelect: onEdit },
            { label: "Revoke…", onSelect: onAskRevoke, danger: true },
          ]}
        />
      ) : null}
    </li>
  );
}
