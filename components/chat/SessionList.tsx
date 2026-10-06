"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionSummary } from "@/lib/hermes";
import { relativeTime } from "@/lib/time";
import { api } from "@/lib/client/api";
import { kvGet, kvSet } from "@/lib/client/idb";
import { Badge, Button, ErrorNote, Spinner, cx, inputCls, useOnline, useToast } from "@/components/ui";
import { ForkIcon, PlusIcon } from "@/components/icons";
import { BackendSwitch, useAssistantChoice } from "./backend";

export function useSessions(archived = false) {
  const [cached, setCached] = useState<SessionSummary[]>();
  useEffect(() => {
    kvGet<SessionSummary[]>("sessions:list").then((c) => c && setCached(c));
  }, []);
  const q = useQuery({
    queryKey: ["sessions", archived],
    queryFn: async () => {
      const r = await api.get<{ sessions: SessionSummary[] }>(`/api/hermes/sessions${archived ? "?archived=1" : ""}`);
      if (!archived) kvSet("sessions:list", r.sessions.slice(0, 50));
      return r.sessions;
    },
    refetchInterval: 30_000,
  });
  return { ...q, sessions: q.data ?? (archived ? undefined : cached), fromCache: !q.data && Boolean(cached) };
}

export function NewConversationButton({ className }: { className?: string }) {
  const router = useRouter();
  const online = useOnline();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { backend } = useAssistantChoice();
  return (
    <Button
      variant="primary"
      className={className}
      busy={busy}
      disabled={!online}
      onClick={async () => {
        setBusy(true);
        try {
          const s = await api.post<SessionSummary>("/api/hermes/sessions", { backend });
          router.push(`/chat/${encodeURIComponent(s.id)}`);
        } catch (err) {
          toast((err as Error).message, "danger");
        } finally {
          setBusy(false);
        }
      }}
    >
      <PlusIcon className="h-5 w-5" /> New conversation
    </Button>
  );
}

export function SessionList({ compact }: { compact?: boolean }) {
  const pathname = usePathname();
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const { sessions, isLoading, error, refetch, fromCache } = useSessions(showArchived);

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const s = (sessions ?? []).filter((x) => !f || x.title.toLowerCase().includes(f) || x.preview?.toLowerCase().includes(f));
    return [...s].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
  }, [sessions, filter]);

  return (
    <div className="flex flex-col gap-3">
      <BackendSwitch className="self-start" />
      <NewConversationButton className="w-full" />
      <div className="flex gap-2">
        <label htmlFor="session-filter" className="sr-only">
          Filter conversations
        </label>
        <input id="session-filter" className={inputCls} placeholder="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
        <input type="checkbox" className="h-5 w-5" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>
      {fromCache ? <p className="text-xs text-warn">Showing saved list — refreshing…</p> : null}
      {error && !sessions ? <ErrorNote error={error} retry={() => refetch()} /> : null}
      {isLoading && !sessions ? <Spinner label="Loading conversations…" /> : null}
      <ul className="space-y-1" aria-label="Conversations">
        {list.map((s) => {
          const href = `/chat/${encodeURIComponent(s.id)}`;
          const active = pathname === href;
          return (
            <li key={s.id}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx("block rounded-xl border px-3 py-2.5", active ? "border-accent bg-accent-soft" : "border-transparent hover:bg-surface-2")}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                  {s.source === "claude" ? <Badge>Claude</Badge> : null}
                  {s.activeRun ? (
                    <Badge tone={s.activeRun.status === "waiting_for_approval" ? "warn" : "accent"}>
                      {s.activeRun.status === "waiting_for_approval" ? "Needs you" : "Running"}
                    </Badge>
                  ) : null}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {s.parentSessionId ? (
                    <span className="inline-flex items-center gap-1">
                      <ForkIcon className="h-3.5 w-3.5" /> Fork
                    </span>
                  ) : null}
                  {s.pinned ? <span>Pinned</span> : null}
                  {s.archived ? <span>Archived</span> : null}
                  {s.lastActiveAt ? <span data-dynamic>{relativeTime(s.lastActiveAt)}</span> : null}
                </span>
                {!compact && s.preview ? <span className="mt-0.5 block truncate text-sm text-muted">{s.preview}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {sessions && !list.length ? <p className="text-sm text-muted">{filter ? "No matches." : "No conversations yet."}</p> : null}
    </div>
  );
}
