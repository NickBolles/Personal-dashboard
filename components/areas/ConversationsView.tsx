"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { QuickCapture } from "@/components/chat/QuickCapture";
import { ContextNote } from "@/components/chat/ContextNote";
import { BackendSwitch } from "@/components/chat/backend";
import { Badge, Button, ErrorNote, OverflowMenu, Spinner, cx, useToast } from "@/components/ui";
import { ChipSelect } from "@/components/ui/kit";
import { ChatIcon } from "@/components/icons";
import { useWorkMutation } from "@/components/work/common";
import { FileUnderDialog, FilingActions, UpdatingNote, pollWhileUpdating } from "@/components/work/conversations";
import type { ConversationFilter, ConversationListResponse, ItemsResponse } from "@/lib/work";

type Row = ConversationListResponse["conversations"][number];
/** C4 chips: All · Unread · Agents · Unfiled (server view `unfiled`; the rest filter the `all` list here). */
type Chip = "all" | "unread" | "agents" | "unfiled";

/** C1/C4 agent mark: the routed Hermes profile, else the assistant. */
export function agentMark(c: { agentProfile?: string | null; backend: string }) {
  return c.agentProfile ? `@${c.agentProfile}` : c.backend === "claude" ? "Claude" : "Hermes";
}

/** Root area of a placement (for the area filter). */
function rootArea(items: ItemsResponse["items"], parentId: string | undefined) {
  const byId = new Map(items.map((i) => [i.id, i]));
  let cur = parentId ? byId.get(parentId) : undefined;
  for (let n = 0; cur && cur.parentId && n < 50; n++) cur = byId.get(cur.parentId);
  return cur?.id ?? null;
}

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
  const [chip, setChip] = useState<Chip>(initialFilter === "unfiled" ? "unfiled" : "all");
  const [areaId, setAreaId] = useState("");
  const filter: ConversationFilter = chip === "unfiled" ? "unfiled" : "all";
  const qc = useQueryClient();
  const { toast } = useToast();
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
  const choose = (f: Chip) => {
    setChip(f);
    const url = new URL(window.location.href);
    if (f === "unfiled") url.searchParams.set("view", "unfiled");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  };
  const allItems = items.data?.items ?? [];
  const areas = allItems.filter((i) => i.parentId === null && !i.archived);
  const list = (q.data?.conversations ?? [])
    .filter((c) => (chip === "unread" ? c.unread : chip === "agents" ? Boolean(c.agentProfile) : true))
    .filter((c) => !areaId || rootArea(allItems, c.placement?.parentId) === areaId);
  const markAll = () =>
    api
      .post("/api/work/conversations/read", { all: true })
      .then(() => {
        toast("All conversations marked read", "ok");
        return qc.invalidateQueries({ queryKey: ["work", "conversations", "view"] });
      })
      .catch((e) => toast((e as Error).message, "danger"));
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
      {context ? <ContextNote context={context} /> : null}
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
        {/* Wraps at 320 px / 200% text instead of pushing the page sideways. */}
        <div role="group" aria-label="Show" className="seg max-w-full flex-wrap">
          <button type="button" className="seg-item" aria-pressed={chip === "all"} aria-label="All conversations" onClick={() => choose("all")}>
            All
          </button>
          <button type="button" className="seg-item" aria-pressed={chip === "unread"} onClick={() => choose("unread")}>
            Unread
            {q.data?.unreadCount ? (
              <span data-dynamic className="tabular-nums text-accent">
                {q.data.unreadCount}
              </span>
            ) : null}
          </button>
          <button type="button" className="seg-item" aria-pressed={chip === "agents"} onClick={() => choose("agents")}>
            Agents
          </button>
          <button type="button" className="seg-item" aria-pressed={chip === "unfiled"} onClick={() => choose("unfiled")}>
            Unfiled
            {q.data ? (
              <span data-dynamic className="tabular-nums text-muted">
                {q.data.unfiledCount}
              </span>
            ) : null}
          </button>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1">
          {areas.length ? (
            <ChipSelect
              aria-label="Area"
              value={areaId}
              active={Boolean(areaId)}
              onChange={(e) => setAreaId(e.target.value)}
              className="w-36 [&>select]:w-full"
            >
              <option value="">All areas</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </ChipSelect>
          ) : null}
          <Button size="sm" variant="ghost" onClick={refresh} busy={revalidating} aria-label="Refresh conversations">
            Refresh
          </Button>
          <OverflowMenu label="Conversation list actions" items={[{ label: "Mark all read", onSelect: markAll, disabled: !q.data?.unreadCount }]} />
        </div>
      </div>
      {q.isPending ? <Spinner label="Loading conversations…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data?.unavailable.length ? (
        <p className="mb-2 text-sm text-warn">{q.data.unavailable.join(", ")} didn&apos;t answer; this list may be incomplete.</p>
      ) : null}
      <UpdatingNote data={q.data} className="mb-2" />
      {q.data && !list.length ? (
        <p className="rounded-[10px] border border-dashed border-line-strong px-3 py-4 text-center text-sm text-muted">
          {chip === "unfiled"
            ? "Nothing unfiled: every conversation has a place."
            : chip === "unread"
              ? "You're all caught up."
              : chip === "agents"
                ? "No conversations with an agent yet."
                : areaId
                  ? "No conversations in this area."
                  : "No conversations yet. Ask anything above."}
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
                <li key={c.id} className="flex items-center gap-x-3 gap-y-1 px-3 py-2" data-conversation={c.id} data-unread={c.unread ? "1" : undefined}>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/chat/${encodeURIComponent(c.id)}`}
                      className={cx("flex min-h-7 items-center gap-1.5 text-[14px] hover:underline", c.unread ? "font-semibold" : "font-medium")}
                    >
                      <ChatIcon className={cx("h-3.5 w-3.5 shrink-0", c.backend === "claude" ? "text-violet" : "text-muted")} />
                      <span className="min-w-0 truncate">{c.title}</span>
                      {c.unread ? (
                        <span className="relative ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent" data-testid="unread">
                          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
                          {c.unreadCount ? (
                            <span className="tabular-nums" data-dynamic>
                              {c.unreadCount}
                            </span>
                          ) : null}
                          <span className="sr-only">{c.unreadCount ? `${c.unreadCount} new` : "Unread"}</span>
                        </span>
                      ) : null}
                    </Link>
                    {/* C4: one meta line — agent · path (plain, truncating) · time. */}
                    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted sm:flex-nowrap">
                      <span className={cx("shrink-0", c.agentProfile && "font-medium text-text")} data-testid="agent-mark">
                        {agentMark(c)}
                      </span>
                      <span aria-hidden="true">·</span>
                      {c.placement && !c.placement.inMisc ? (
                        <span className="min-w-0 truncate" title={c.placement.path}>
                          {c.placement.path}
                        </span>
                      ) : (
                        <span className="min-w-0 truncate">{c.placement ? "Miscellaneous" : "Not in Areas"}</span>
                      )}
                      <span aria-hidden="true">·</span>
                      <span data-dynamic className="shrink-0 tabular-nums">
                        {c.lastActiveAt ? relativeTime(c.lastActiveAt) : "—"}
                      </span>
                      {c.shared ? <Badge tone="accent">Shared</Badge> : null}
                      {c.readOnly ? <Badge>Shared with you</Badge> : null}
                    </p>
                  </div>
                  {unfiled && !c.readOnly ? (
                    <FilingActions
                      c={c}
                      top={top ? { ...top, why: `${top.path} — shares: ${top.matched.join(", ")}` } : null}
                      busy={file.isPending && file.variables?.sessionId === c.id}
                      inMisc={!!c.placement?.inMisc}
                      onFile={(itemId) => file.mutate({ sessionId: c.id, itemId })}
                      onPick={() => setFiling(c)}
                    />
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
