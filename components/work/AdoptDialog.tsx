"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { Dialog, ErrorNote, Field, useToast } from "@/components/ui";
import { Button, Spinner, inputCls } from "@/components/ui/legacy";
import { fmtWhen } from "@/components/work/conversations";
import type { WorkItem } from "@/lib/work";

type Adoptable = {
  profile: string | null;
  profiles: string[];
  sessions: { id: string; title: string; lastActiveAt?: string; messageCount?: number; source?: string }[];
};

/**
 * Adopt an existing Hermes chat (one Jarvis didn't start — e.g. from the Hermes web UI) into
 * this area: pick the agent, pick the chat, confirm. The agent's Bot Chat inbox, hidden,
 * sync and sub-agent sessions are never offered (and the server refuses them anyway).
 */
export function AdoptDialog({ item, onClose, onDone }: { item: WorkItem; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // undefined = the area's own agent (server resolves it from the area's agent mode).
  const [profile, setProfile] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState<{ id: string; title: string } | null>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = profile === undefined ? `itemId=${encodeURIComponent(item.id)}` : `profile=${encodeURIComponent(profile)}`;
  const list = useQuery({ queryKey: ["adoptable", q], queryFn: () => api.get<Adoptable>(`/api/hermes/sessions/adoptable?${q}`), retry: false });
  // #186: an explicit pick wins even while the list is loading or failed; the area's own agent
  // (no pick) is only known once the list answers, so adopting waits for it.
  const current: string | null | undefined = profile !== undefined ? (profile === "default" ? null : profile) : list.data ? list.data.profile : undefined;
  const unresolved = current === undefined;

  const adopt = async () => {
    if (!picked || current === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/hermes/sessions/adopt", { profile: current, sessionId: picked.id });
      await api.post("/api/work/conversations/file", { sessionId: picked.id, itemId: item.id });
      qc.invalidateQueries({ queryKey: ["work"] });
      qc.invalidateQueries({ queryKey: ["adoptable"] });
      refreshSessionLists(qc);
      toast(`Filed under ${item.title}`, "ok");
      onDone?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (picked)
    return (
      <Dialog
        open
        onClose={onClose}
        title="Adopt this chat?"
        description={`Jarvis will track it on ${current ?? "the default agent"} and file it under ${item.title}. Nothing in the chat changes.`}
        footer={
          <>
            <Button onClick={() => setPicked(null)} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" busy={busy} disabled={unresolved} onClick={() => void adopt()} data-autofocus>
              Adopt and file
            </Button>
          </>
        }
      >
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{picked.title}</p>
        <p className="mt-0.5 font-mono text-xs text-muted [overflow-wrap:anywhere]">{picked.id}</p>
        {error ? (
          <div className="mt-2">
            <ErrorNote error={error} />
          </div>
        ) : null}
      </Dialog>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Adopt an existing chat"
      description="Chats you started outside Jarvis on this agent. The Bot Chat inbox is never listed."
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-3">
        <Field id="adopt-profile" label="Agent">
          <select id="adopt-profile" className={inputCls} value={profile ?? current ?? "default"} onChange={(e) => setProfile(e.target.value)}>
            <option value="default">Default (Hermes)</option>
            {[...new Set([...(list.data?.profiles ?? []), ...(current ? [current] : [])])].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        {list.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading chats…
          </p>
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.data.sessions.length ? (
          <ul className="max-h-[50vh] divide-y divide-line overflow-auto rounded-lg border border-line" aria-label="Chats to adopt">
            {list.data.sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
                  onClick={() => setPicked({ id: s.id, title: s.title })}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
                  <span className="shrink-0 text-xs text-muted" data-dynamic>
                    {s.messageCount ? `${s.messageCount} msgs · ` : ""}
                    {fmtWhen(s.lastActiveAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No other chats on this agent.</p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const id = paste.trim().replace(/^.*\/chat\//, "");
            if (id) setPicked({ id, title: id });
          }}
        >
          <div className="min-w-0 flex-1 basis-48">
            <Field id="adopt-id" label="Or paste a session id">
              <input id="adopt-id" className={inputCls} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="20261103_…" />
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={!paste.trim() || unresolved}>
            Next
          </Button>
        </form>
      </div>
    </Dialog>
  );
}
