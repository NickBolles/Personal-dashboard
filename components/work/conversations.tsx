"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Dialog, ErrorNote, Field, Spinner, cx, inputCls } from "@/components/ui";
import type {
  ConversationIndexState,
  ConversationOption,
  ConversationsResponse,
  FilingSuggestion,
  LinkRole,
  UnfiledConversation,
  UnfiledResponse,
  WorkItem,
} from "@/lib/work";
import { useWorkMutation } from "./common";

export function fmtWhen(at: string | null | undefined) {
  if (!at) return "—";
  const d = new Date(at);
  if (!Number.isFinite(d.valueOf())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const BACKEND = { hermes: "Hermes", claude: "Claude" } as const;

/** While the server is refreshing a cached conversation list in the background, poll until it lands. */
export const pollWhileUpdating = (query: { state: { data?: ConversationIndexState } }) => (query.state.data?.updating ? 2_500 : false);

/** Subtle "Updating…" for a cached list being refreshed (instead of the "didn't answer" warning). */
export function UpdatingNote({ data, className }: { data?: ConversationIndexState & { unavailable: string[] }; className?: string }) {
  if (!data?.updating || data.unavailable.length) return null;
  return (
    <p role="status" className={cx("text-xs text-muted", className)} data-dynamic>
      Updating…
    </p>
  );
}

export function useConversations(enabled = true) {
  return useQuery({
    queryKey: ["work", "conversations"],
    queryFn: () => api.get<ConversationsResponse>("/api/work/conversations"),
    enabled,
    staleTime: 30_000,
    refetchInterval: pollWhileUpdating,
  });
}

/** Item paths ("Area › Project › Thread") for destination pickers, sorted. */
export function itemPaths(items: WorkItem[], exclude: Set<string> = new Set()) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const path = (i: WorkItem) => {
    const parts = [i.title];
    for (let p = i.parentId ? byId.get(i.parentId) : undefined; p && parts.length < 8; p = p.parentId ? byId.get(p.parentId) : undefined)
      parts.unshift(p.title);
    return parts.join(" › ");
  };
  return items
    .filter((i) => !exclude.has(i.id))
    .map((i) => ({ id: i.id, label: path(i) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Searchable list of your conversations (Hermes + Claude). */
export function ConversationPicker({ onPick, busy, linkedHere }: { onPick: (c: ConversationOption) => void; busy?: boolean; linkedHere: Set<string> }) {
  const q = useConversations();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const list = (q.data?.conversations ?? []).filter((c) => !needle || `${c.title} ${c.preview ?? ""}`.toLowerCase().includes(needle));
  return (
    <div className="space-y-2">
      <Field id="cp-filter" label="Search conversations">
        <input
          id="cp-filter"
          data-autofocus
          type="search"
          className={inputCls}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Title or text…"
        />
      </Field>
      {q.isPending ? <Spinner label="Loading conversations…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data?.unavailable.length ? <p className="text-sm text-warn">{q.data.unavailable.join(", ")} didn&apos;t answer; the list may be incomplete.</p> : null}
      <UpdatingNote data={q.data} />
      {q.data ? (
        list.length ? (
          <ul aria-label="Conversations" className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {list.map((c) => {
              const here = linkedHere.has(c.id);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{c.title}</p>
                    <p className="text-xs text-muted">
                      {BACKEND[c.backend]} · {fmtWhen(c.lastActiveAt)}
                      {c.readOnly ? " · shared, read-only" : ""}
                      {c.linkedItems.length ? ` · linked to ${c.linkedItems.map((i) => i.title).join(", ")}` : ""}
                    </p>
                  </div>
                  <Button size="sm" disabled={here || busy} onClick={() => onPick(c)} aria-label={here ? `${c.title} is already linked` : `Link ${c.title}`}>
                    {here ? "Linked" : "Link"}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{needle ? "No conversation matches." : "No conversations yet."}</p>
        )
      ) : null}
    </div>
  );
}

export function ConversationLinkDialog({ item, linkedHere, onClose }: { item: WorkItem; linkedHere: Set<string>; onClose: () => void }) {
  const [role, setRole] = useState<LinkRole>("source");
  const [paste, setPaste] = useState("");
  const add = useWorkMutation(
    (targetId: string) => api.post(`/api/work/items/${encodeURIComponent(item.id)}/links`, { kind: "chat_session", targetId, role }),
    { ok: "Linked", onSuccess: onClose },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Link a conversation"
      description="Pick one of your Hermes or Claude conversations."
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-3">
        <Field id="lk-role" label="Role">
          <select id="lk-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value as LinkRole)}>
            <option value="source">Source</option>
            <option value="implementation">Implementation</option>
            <option value="evidence">Evidence</option>
            <option value="reference">Reference</option>
          </select>
        </Field>
        <ConversationPicker linkedHere={linkedHere} busy={add.isPending} onPick={(c) => add.mutate(c.id)} />
        <details className="text-sm">
          <summary className="tap cursor-pointer text-accent">Not in the list? Paste a /chat link</summary>
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (paste.trim()) add.mutate(paste.trim());
            }}
          >
            <div className="min-w-0 flex-1">
              <Field id="lk-paste" label="Conversation id or /chat link">
                <input id="lk-paste" className={inputCls} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="/chat/…" />
              </Field>
            </div>
            <Button type="submit" size="sm" disabled={!paste.trim()} busy={add.isPending}>
              Link pasted
            </Button>
          </form>
        </details>
      </div>
    </Dialog>
  );
}

/** "Unfiled conversations": recent chats not linked to any work item, with one-click filing. */
export function UnfiledPanel({ items, dismissable }: { items: WorkItem[]; dismissable?: boolean }) {
  const q = useQuery({
    queryKey: ["work", "unfiled"],
    queryFn: () => api.get<UnfiledResponse>("/api/work/conversations/unfiled"),
    refetchInterval: pollWhileUpdating,
  });
  const [all, setAll] = useState(false);
  const [filing, setFiling] = useState<UnfiledConversation | null>(null);
  const file = useWorkMutation((v: { sessionId: string; itemId: string | null }) => api.post<{ itemId: string }>("/api/work/conversations/file", v), {
    ok: "Filed",
  });
  // Hides it from the Work inbox; only the id is remembered (Hermes keeps the conversation).
  const dismiss = useWorkMutation((sessionId: string) => api.post("/api/work/inbox/conversations/dismiss", { sessionId }), { ok: "Dismissed" });
  const list = q.data?.conversations ?? [];
  const shown = all ? list : list.slice(0, 5);
  return (
    <section aria-labelledby="unfiled-heading" className="wk-card min-w-0 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="unfiled-heading" className="wk-label">
          Unfiled conversations
        </h2>
        {q.data ? <span className="text-xs text-muted tabular-nums">{q.data.total}</span> : null}
      </div>
      {q.isPending ? <Spinner label="Loading conversations…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data?.unavailable.length ? (
        <p className="mb-2 text-sm text-warn">{q.data.unavailable.join(", ")} didn&apos;t answer; this may be incomplete.</p>
      ) : null}
      <UpdatingNote data={q.data} className="mb-2" />
      {q.data && !list.length ? <p className="text-sm text-muted">Every recent conversation is filed.</p> : null}
      <ul className="wk-rows">
        {shown.map((c) => {
          const top = c.suggestions[0];
          return (
            <li key={c.id} className="py-2" data-unfiled={c.id}>
              <p className="text-[14px] font-semibold break-words">
                <Link href={`/chat/${encodeURIComponent(c.id)}`} className="hover:underline">
                  {c.title}
                </Link>
              </p>
              <p className="text-xs text-muted">
                {BACKEND[c.backend]} · {fmtWhen(c.lastActiveAt)}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {top ? (
                  <Button
                    size="sm"
                    variant="primary"
                    busy={file.isPending && file.variables?.itemId === top.id && file.variables?.sessionId === c.id}
                    onClick={() => file.mutate({ sessionId: c.id, itemId: top.id })}
                    aria-label={`File under ${top.title}: ${c.title}`}
                    title={`Shares the words: ${top.matched.join(", ")}`}
                  >
                    File under {top.title}
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => setFiling(c)} aria-label={`File under…: ${c.title}`}>
                  File under…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => file.mutate({ sessionId: c.id, itemId: null })}
                  aria-label={`File in Miscellaneous: ${c.title}`}
                >
                  File in Miscellaneous
                </Button>
                {dismissable ? (
                  <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(c.id)} aria-label={`Dismiss: ${c.title}`}>
                    Dismiss
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {list.length > 5 ? (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${list.length}`}
        </Button>
      ) : null}
      {filing ? (
        <FileUnderDialog
          c={filing}
          items={items}
          busy={file.isPending}
          onClose={() => setFiling(null)}
          onFile={(itemId) => file.mutate({ sessionId: filing.id, itemId }, { onSuccess: () => setFiling(null) })}
        />
      ) : null}
    </section>
  );
}

export function FileUnderDialog({
  c,
  items,
  busy,
  onClose,
  onFile,
}: {
  c: { id: string; title: string; suggestions: FilingSuggestion[] };
  items: WorkItem[];
  busy: boolean;
  onClose: () => void;
  onFile: (itemId: string) => void;
}) {
  const [dest, setDest] = useState(c.suggestions[0]?.id ?? "");
  // Conversations go under areas, projects, threads… (or another conversation); never inside a note.
  const options = itemPaths(items, new Set(items.filter((i) => i.kind === "note" || i.sessionId === c.id).map((i) => i.id)));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`File ${c.title}`}
      description="Puts the conversation under the item you pick in the Areas tree. Nothing in the conversation changes."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!dest} busy={busy} onClick={() => onFile(dest)}>
            File here
          </Button>
        </>
      }
    >
      {c.suggestions.length ? <p className="mb-2 text-sm text-muted">Suggested (title words match): {c.suggestions.map((s) => s.title).join(", ")}</p> : null}
      <Field id="fu-dest" label="Destination">
        <select id="fu-dest" className={inputCls} value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    </Dialog>
  );
}
