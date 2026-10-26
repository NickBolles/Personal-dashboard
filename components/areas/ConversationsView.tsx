"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { QuickCapture } from "@/components/chat/QuickCapture";
import { BackendSwitch } from "@/components/chat/backend";
import { Badge, Button, ErrorNote, Spinner, cx } from "@/components/ui";
import { ChatIcon } from "@/components/icons";
import { useWorkMutation } from "@/components/work/common";
import { FileUnderDialog, UpdatingNote, pollWhileUpdating } from "@/components/work/conversations";
import type { ConversationFilter, ConversationListResponse, ItemsResponse } from "@/lib/work";

type Row = ConversationListResponse["conversations"][number];

function group(at: string | null, now = Date.now()) {
  if (!at) return "Older";
  const t = new Date(at).getTime();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (t >= start.getTime()) return "Today";
  if (now - t < 7 * 86_400_000) return "This week";
  return "Older";
}

/**
 * The conversations view of the Areas tree (/chat for people with Areas):
 * one list over the same data, filtered All / Unfiled ("Unfiled" = not in the
 * tree, or only in Miscellaneous). New chats start from the box at the top with
 * zero filing; filing stays one tap (suggested destination chips).
 */
export function ConversationsView({
  startNew,
  context,
  draft,
  initialFilter,
}: {
  startNew?: boolean;
  context?: string;
  draft?: string;
  initialFilter?: ConversationFilter;
}) {
  const [filter, setFilter] = useState<ConversationFilter>(initialFilter ?? "all");
  const qc = useQueryClient();
  const key = ["work", "conversations", "view", filter];
  // Answers from the persisted index at once; while it refreshes in the background, poll.
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<ConversationListResponse>(`/api/work/conversations?view=${filter}`),
    refetchInterval: pollWhileUpdating,
  });
  // Refresh asks the server to revalidate now; the reply (cached, `updating`) starts the polling.
  const [revalidating, setRevalidating] = useState(false);
  const refresh = () => {
    setRevalidating(true);
    api
      .get<ConversationListResponse>(`/api/work/conversations?view=${filter}&refresh=1`)
      .then((d) => qc.setQueryData(key, d))
      .catch(() => q.refetch())
      .finally(() => setRevalidating(false));
  };
  const items = useQuery({ queryKey: ["work", "items", false], queryFn: () => api.get<ItemsResponse>("/api/work/items") });
  const [filing, setFiling] = useState<Row | null>(null);
  const file = useWorkMutation((v: { sessionId: string; itemId: string | null }) => api.post("/api/work/conversations/file", v), { ok: "Filed" });
  const choose = (f: ConversationFilter) => {
    setFilter(f);
    const url = new URL(window.location.href);
    if (f === "unfiled") url.searchParams.set("view", "unfiled");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  };
  const list = q.data?.conversations ?? [];
  const groups = (["Today", "This week", "Older"] as const)
    .map((g) => ({ g, rows: list.filter((c) => group(c.lastActiveAt) === g) }))
    .filter((x) => x.rows.length);
  return (
    <div className="mx-auto w-full max-w-[880px] px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-semibold tracking-tight">Conversations</h1>
          <p className="text-[13px] text-muted">New chats land in Miscellaneous. File them later — or never.</p>
        </div>
        <BackendSwitch />
      </header>
      {context ? (
        <div className="mb-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-sm">
          <p className="eyebrow">Attached context</p>
          <p className="mt-0.5">{context}</p>
        </div>
      ) : null}
      <div className="mb-3">
        <QuickCapture
          key={draft ?? "q"}
          mode="ask"
          initialText={draft}
          context={context}
          placeholder={startNew || context ? "What should Hermes do with this?" : "New chat — ask anything…"}
        />
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Show" className="seg">
          <button type="button" className="seg-item" aria-pressed={filter === "all"} onClick={() => choose("all")}>
            All conversations
          </button>
          <button type="button" className="seg-item" aria-pressed={filter === "unfiled"} onClick={() => choose("unfiled")}>
            Unfiled
            {q.data ? (
              <span data-dynamic className="tabular-nums text-muted">
                {q.data.unfiledCount}
              </span>
            ) : null}
          </button>
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} busy={revalidating} aria-label="Refresh conversations">
          Refresh
        </Button>
      </div>
      {q.isPending ? <Spinner label="Loading conversations…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data?.unavailable.length ? (
        <p className="mb-2 text-sm text-warn">{q.data.unavailable.join(", ")} didn&apos;t answer; this list may be incomplete.</p>
      ) : null}
      <UpdatingNote data={q.data} className="mb-2" />
      {q.data && !list.length ? (
        <p className="rounded-[10px] border border-dashed border-line-strong px-3 py-4 text-center text-sm text-muted">
          {filter === "unfiled" ? "Nothing unfiled: every conversation has a place." : "No conversations yet. Ask anything above."}
        </p>
      ) : null}
      {groups.map(({ g, rows }) => (
        <section key={g} aria-label={g} className="mb-3">
          <h2 className="mb-1 px-1 text-[13px] font-semibold text-muted">{g}</h2>
          <ul className="rows card overflow-hidden p-0" aria-label={`${g} conversations`}>
            {rows.map((c) => {
              const top = c.suggestions[0];
              const unfiled = !c.placement || c.placement.inMisc;
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-conversation={c.id}>
                  <div className="min-w-0 flex-1 basis-60">
                    <Link href={`/chat/${encodeURIComponent(c.id)}`} className="flex min-h-7 items-center gap-1.5 text-[14px] font-medium hover:underline">
                      <ChatIcon className={cx("h-3.5 w-3.5 shrink-0", c.backend === "claude" ? "text-violet" : "text-muted")} />
                      <span className="min-w-0 truncate">{c.title}</span>
                    </Link>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span>{c.backend === "claude" ? "Claude" : "Hermes"}</span>
                      <span aria-hidden="true">·</span>
                      <span data-dynamic>{c.lastActiveAt ? relativeTime(c.lastActiveAt) : "—"}</span>
                      {c.placement && !c.placement.inMisc ? (
                        <span className="chip" title={c.placement.path}>
                          {c.placement.path}
                        </span>
                      ) : (
                        <span className="chip">{c.placement ? "Miscellaneous" : "Not in Areas"}</span>
                      )}
                      {c.shared ? <Badge tone="accent">Shared</Badge> : null}
                      {c.readOnly ? <Badge>Shared with you</Badge> : null}
                    </p>
                  </div>
                  {unfiled && !c.readOnly ? (
                    <div className="flex flex-wrap gap-1">
                      {top ? (
                        <Button
                          size="sm"
                          onClick={() => file.mutate({ sessionId: c.id, itemId: top.id })}
                          busy={file.isPending && file.variables?.sessionId === c.id && file.variables?.itemId === top.id}
                          aria-label={`File under ${top.title}: ${c.title}`}
                          title={`${top.path} — shares: ${top.matched.join(", ")}`}
                        >
                          File under {top.title}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setFiling(c)} aria-label={`File…: ${c.title}`}>
                        File…
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {filing ? (
        <FileUnderDialog
          c={filing}
          items={items.data?.items ?? []}
          busy={file.isPending}
          onClose={() => setFiling(null)}
          onFile={(itemId) => file.mutate({ sessionId: filing.id, itemId }, { onSuccess: () => setFiling(null) })}
        />
      ) : null}
    </div>
  );
}
