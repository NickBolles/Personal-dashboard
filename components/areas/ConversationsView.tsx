"use client";

import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { QuickCapture } from "@/components/chat/QuickCapture";
import { ContextNote } from "@/components/chat/ContextNote";
import { BackendSwitch, useAssistantChoice } from "@/components/chat/backend";
import { scheduledTitle } from "@/lib/chat/display";
import { ChipButton, ErrorNote, Pill, cx, useToast } from "@/components/ui";
import { OverflowMenu, Spinner } from "@/components/ui/legacy";
import { AreaPickerDot, SelectPicker } from "@/components/work/MetaPicker";
import { ChatIcon } from "@/components/icons";
import { useWorkMutation } from "@/components/work/common";
import { FileUnderDialog, UpdatingNote, pollWhileUpdating } from "@/components/work/conversations";
import type { ConversationFilter, ConversationListResponse, ItemsResponse } from "@/lib/work";
import "./conversations-view.css";

type Row = ConversationListResponse["conversations"][number];
/** C4 chips are applied server-side before the bounded list window. */
type Chip = "all" | "unread" | "agents" | "unfiled";

/**
 * C1/C4 agent mark: the routed Hermes profile, else the assistant, and only when that says something.
 * A row answered by the default assistant carries no mark (every row repeating "Hermes" is noise).
 */
export function agentMark(c: { agentProfile?: string | null; backend: string }, defaultBackend = "hermes"): string | null {
  if (c.agentProfile) return `@${c.agentProfile}`;
  if (c.backend === defaultBackend) return null;
  return c.backend === "claude" ? "Claude" : "Hermes";
}

/** Meta parts with a "·" between them: nothing renders for a missing part, so no separator ever dangles. */
function Dotted({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false);
  return (
    <>
      {shown.map((part, i) => (
        <Fragment key={i}>
          {i ? <span aria-hidden="true">·</span> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
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
  const filter: ConversationFilter = chip;
  const params = new URLSearchParams({ view: filter, ...(areaId ? { areaId } : {}) });
  const qc = useQueryClient();
  const { toast } = useToast();
  const defaultBackend = useAssistantChoice().status?.defaultBackend ?? "hermes";
  const key = ["work", "conversations", "view", filter, areaId];
  // Answers from the persisted index at once; while it refreshes in the background, poll.
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<ConversationListResponse>(`/api/work/conversations?${params}`),
    refetchInterval: pollWhileUpdating,
  });
  // Refresh asks the server to revalidate now; the reply (cached, `updating`) starts the polling.
  const [revalidating, setRevalidating] = useState(false);
  const refresh = () => {
    setRevalidating(true);
    api
      .get<ConversationListResponse>(`/api/work/conversations?${params}&refresh=1`)
      .then((d) => qc.setQueryData(key, d))
      .catch(() => q.refetch())
      .finally(() => setRevalidating(false));
  };
  const listMenu = [
    // The list refreshes itself in the background ("Updating…"); this asks for it now.
    { label: revalidating ? "Refreshing…" : "Refresh now", onSelect: refresh, disabled: revalidating },
    { label: "Mark all read", onSelect: () => void markAll(), disabled: !q.data?.unreadCount },
  ];
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
  const list = q.data?.conversations ?? [];
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
    <div className="cv-root mx-auto w-full max-w-[880px] px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
      {/* One header row: the title, then what scopes the list (area) and its actions. Phones keep it to a single line. */}
      <header className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex-1">
          <h1 className="text-xl leading-tight font-semibold tracking-tight">Conversations</h1>
          <p className="hidden text-xs text-muted sm:block">New chats land in Miscellaneous. File them later, or never.</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1">
          <BackendSwitch />
          {areas.length ? (
            <SelectPicker
              label="Area"
              value={areaId}
              active={Boolean(areaId)}
              onChange={setAreaId}
              className="max-w-40"
              options={[
                { value: "", label: "All areas" },
                ...areas.map((a) => ({ value: a.id, label: a.title, dot: <AreaPickerDot color={a.settings?.color} /> })),
              ]}
            />
          ) : null}
          <OverflowMenu
            label="Conversation list actions"
            items={listMenu}
            triggerClassName="cv-icon-btn inline-flex items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
          />
        </div>
      </header>
      {context ? <ContextNote context={context} /> : null}
      <div className="mb-2">
        <QuickCapture
          key={draft ?? "q"}
          mode="ask"
          initialText={draft}
          context={context}
          placeholder={startNew || context ? "What should Hermes do with this?" : "New chat — ask anything…"}
        />
      </div>
      {/* Wraps at 320 px / 200% text instead of pushing the page sideways. */}
      <div role="group" aria-label="Show" className="seg mb-2 max-w-full flex-wrap">
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
          <h2 className="mb-1 px-1 text-xs font-semibold text-muted">{g}</h2>
          <ul className="rows card overflow-hidden p-0" aria-label={`${g} conversations`}>
            {rows.map((c) => {
              const top = c.suggestions[0];
              const filed = !!c.placement && !c.placement.inMisc;
              const canFile = !filed && !c.readOnly;
              const filing = file.isPending && file.variables?.sessionId === c.id;
              const scheduled = scheduledTitle(c.title);
              const mark = agentMark(c, defaultBackend);
              return (
                // The title link stretches over the whole row (::after), so anywhere on it opens the chat; the
                // filing action and the ⋯ menu sit above that layer and stay separate, valid controls.
                <li
                  key={c.id}
                  className="relative flex flex-wrap items-start gap-x-2 px-3 py-1.5 hover:bg-surface-2"
                  data-conversation={c.id}
                  data-unread={c.unread ? "1" : undefined}
                  data-placement={filed ? "filed" : c.placement ? "misc" : "none"}
                >
                  <Link
                    href={`/chat/${encodeURIComponent(c.id)}`}
                    title={scheduled ? c.title : undefined}
                    className={cx(
                      "flex min-h-6 min-w-0 flex-1 items-start gap-1.5 py-0.5 text-sm leading-5 outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-accent focus-visible:after:ring-inset",
                      c.unread ? "font-semibold" : "font-medium",
                    )}
                  >
                    <ChatIcon className={cx("mt-0.5 h-3.5 w-3.5 shrink-0", c.backend === "claude" ? "text-violet" : "text-muted")} />
                    <span className="line-clamp-2 min-w-0 break-words sm:line-clamp-1">{scheduled ? scheduled.title : c.title}</span>
                  </Link>
                  {c.unread ? (
                    <span className="mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 text-xs font-semibold text-accent" data-testid="unread">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
                      {c.unreadCount ? (
                        <span className="tabular-nums" data-dynamic>
                          {c.unreadCount}
                        </span>
                      ) : null}
                      <span className="sr-only">{c.unreadCount ? `${c.unreadCount} new` : "Unread"}</span>
                    </span>
                  ) : null}
                  {canFile ? (
                    // Negative margins: the button (and its touch slop) does not make a one-line row taller.
                    <div className="relative z-10 -my-1 -mr-1.5 shrink-0">
                      <OverflowMenu
                        label={`Filing options: ${c.title}`}
                        triggerClassName="cv-icon-btn inline-flex items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
                        items={[
                          { label: "File under…", onSelect: () => setFiling(c) },
                          ...(c.placement?.inMisc ? [] : [{ label: "File in Miscellaneous", onSelect: () => file.mutate({ sessionId: c.id, itemId: null }) }]),
                        ]}
                      />
                    </div>
                  ) : null}
                  {/* C4: one meta line under the title, full width. Only what distinguishes this row: who answers
                      (when not the default), where it is filed, when; then a filing suggestion, if there is one. */}
                  <p className="flex min-h-5 min-w-0 basis-full flex-wrap items-center gap-x-2 text-xs text-muted empty:hidden">
                    <Dotted
                      parts={[
                        mark ? (
                          <span className={cx("shrink-0", c.agentProfile && "font-medium text-text")} data-testid="agent-mark">
                            {mark}
                          </span>
                        ) : null,
                        filed ? (
                          <span className="min-w-0 truncate" title={c.placement!.path}>
                            {c.placement!.path}
                          </span>
                        ) : null,
                        c.lastActiveAt ? (
                          <span data-dynamic className="shrink-0 tabular-nums">
                            {relativeTime(c.lastActiveAt)}
                          </span>
                        ) : null,
                      ]}
                    />
                    {scheduled ? (
                      <span title={`Delivered by the scheduled job ${scheduled.job}`} data-testid="scheduled-tag">
                        <Pill>Scheduled</Pill>
                      </span>
                    ) : null}
                    {c.shared ? <Pill tone="ac">Shared</Pill> : null}
                    {c.readOnly ? <Pill>Shared with you</Pill> : null}
                    {canFile && top ? (
                      <ChipButton
                        className="wk-suggest wk-suggest-inline relative z-10"
                        disabled={filing}
                        onClick={() => file.mutate({ sessionId: c.id, itemId: top.id })}
                        aria-label={`File under ${top.title}: ${c.title}`}
                        title={`Suggested: ${top.path} (shares: ${top.matched.join(", ")}). Tap to file.`}
                      >
                        <span aria-hidden="true" className="opacity-70">
                          →
                        </span>
                        <span className="truncate">{top.title}</span>
                      </ChipButton>
                    ) : null}
                  </p>
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
