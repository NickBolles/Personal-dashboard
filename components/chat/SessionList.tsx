"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient, type FetchInfiniteQueryOptions, type InfiniteData } from "@tanstack/react-query";
import type { SessionSummary } from "@/lib/hermes";
import { relativeTime } from "@/lib/time";
import { api } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { mergeSessionPages, type SessionPage } from "@/lib/session-pages";
import { Badge, Button, ErrorNote, Spinner, cx, inputCls, useOnline, useToast } from "@/components/ui";
import { ForkIcon, PlusIcon } from "@/components/icons";
import { BackendSwitch, useAssistantChoice } from "./backend";

// Query Core's fetch-page budget limits refetches, not stored history or
// fetchNextPage. It commits the new head only on success, retaining old pages
// and the normal error/cancellation state until then.
const headWindow = { pages: 1 } satisfies Pick<FetchInfiniteQueryOptions, "pages">;

export function useSessions(archived = false) {
  const client = useQueryClient();
  const queryKey = ["sessions", archived];
  const q = useInfiniteQuery({
    ...headWindow,
    queryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.get<SessionPage>(`/api/hermes/sessions?offset=${pageParam}${archived ? "&archived=1" : ""}`, signal);
      if (page.unavailable?.length && client.getQueryData<InfiniteData<SessionPage>>(queryKey)?.pages.some((p) => p.sessions.length)) {
        throw new Error("Hermes is unavailable. Previously loaded conversations may be stale.");
      }
      return page;
    },
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    // Each upstream list performs a global recency sort. Do not poll or refetch
    // every loaded page on focus/reconnect. Refresh below restarts one window.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A creation outside /chat invalidates an inactive cache. Honor that
    // explicit refresh on return, but do not refetch merely stale history.
    refetchOnMount: (query) => query.state.isInvalidated,
    retry: false,
  });
  const refresh = async () => {
    await client.cancelQueries({ queryKey, exact: true });
    return q.refetch();
  };
  return {
    ...q,
    refetch: refresh,
    sessions: q.data ? mergeSessionPages(q.data.pages) : undefined,
    unavailable: q.data?.pages.at(-1)?.unavailable ?? [],
    fromCache: Boolean(q.data && q.isError),
  };
}

export function NewConversationButton({ className }: { className?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
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
          // Creation succeeded: list refresh must not delay or undo navigation.
          void refreshSessionLists(qc).catch(() => toast("Conversation created, but the list could not refresh. Try Refresh conversations.", "warn"));
        } catch (err) {
          toast((err as Error).message, "danger");
        } finally {
          setBusy(false);
        }
      }}
    >
      <PlusIcon className="h-4 w-4" /> New conversation
    </Button>
  );
}

export function SessionList({ compact }: { compact?: boolean }) {
  const pathname = usePathname();
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const { sessions, isLoading, error, refetch, fromCache, unavailable, hasNextPage, fetchNextPage, isFetching, isFetchNextPageError } =
    useSessions(showArchived);

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const s = (sessions ?? []).filter((x) => !f || x.title.toLowerCase().includes(f) || x.preview?.toLowerCase().includes(f));
    return [...s].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
  }, [sessions, filter]);

  return (
    <div className="flex flex-col gap-2">
      <BackendSwitch className="self-start" />
      <NewConversationButton className="w-full" />
      <div className="flex gap-2">
        <label htmlFor="session-filter" className="sr-only">
          Filter conversations
        </label>
        <input id="session-filter" className={inputCls} placeholder="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <label className="flex min-h-11 items-center gap-2 text-sm text-muted dense:min-h-8">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        <Button size="sm" variant="ghost" className="text-muted" disabled={isFetching} onClick={() => refetch()}>
          Refresh conversations
        </Button>
      </div>
      {fromCache ? <p className="text-xs text-warn">Showing previously loaded conversations — the list may be stale or incomplete.</p> : null}
      {unavailable.length ? (
        <p role="status" className="text-xs text-warn">
          Hermes is unavailable. Showing only local conversations; retry to load Hermes.
        </p>
      ) : null}
      {error ? <ErrorNote error={error} retry={() => (isFetchNextPageError ? fetchNextPage() : refetch())} /> : null}
      {isLoading && !sessions ? <Spinner label="Loading conversations…" /> : null}
      <ul className="-mx-1 space-y-px" aria-label="Conversations">
        {list.map((s) => {
          const href = `/chat/${encodeURIComponent(s.id)}`;
          const active = pathname === href;
          return (
            <li key={s.id}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx("block rounded-[8px] px-2.5 py-2 dense:py-1.5", active ? "bg-accent-soft text-accent" : "hover:bg-surface-2")}
              >
                <span className="flex items-center gap-2">
                  <span className={cx("min-w-0 flex-1 truncate", active ? "font-semibold" : "font-medium")}>{s.title}</span>
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
      {hasNextPage ? (
        <Button busy={isFetching} disabled={isFetching} onClick={() => fetchNextPage()}>
          Load more conversations
        </Button>
      ) : null}
      {hasNextPage ? <p className="text-xs text-muted">More conversations may be available. Filtering searches only the loaded list.</p> : null}
      {sessions && !list.length ? (
        <p className="text-sm text-muted">{hasNextPage ? "No matches in the loaded conversations." : filter ? "No matches." : "No conversations yet."}</p>
      ) : null}
    </div>
  );
}
