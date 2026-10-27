"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, ErrorNote, OverflowMenu, Spinner, useToast } from "@/components/ui";
import { PlusIcon } from "@/components/icons";
import { useWorkMutation } from "@/components/work/common";
import { DestinationPicker } from "@/components/work/DestinationPicker";
import { fmtWhen, pollWhileUpdating, UpdatingNote } from "@/components/work/conversations";
import type { UndoOp } from "@/components/work/UndoBar";
import { ProjectIcon } from "@/components/work/WorkTree";
import { rollup, type CreatableKind, type UnfiledConversation, type UnfiledResponse, type WorkItem } from "@/lib/work";

/**
 * The one "+ New" menu: chat, item, project, area, capture. Items and
 * projects are created in `context` (the open area/project) when there is one.
 */
export function NewMenu({
  canChat,
  busy,
  context,
  onChat,
  onNew,
  onCapture,
}: {
  canChat: boolean;
  busy?: boolean;
  context: WorkItem | null;
  onChat: () => void;
  onNew: (kind: CreatableKind) => void;
  onCapture: () => void;
}) {
  const where = context ? `in ${context.title}` : undefined;
  return (
    <OverflowMenu
      label="New"
      triggerClassName="press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-accent px-3 text-[13.5px] font-semibold text-accent-contrast hover:opacity-90"
      trigger={
        <>
          <PlusIcon className="h-4 w-4" />
          <span>{busy ? "Starting…" : "New"}</span>
          <span aria-hidden="true" className="text-[10px] opacity-80">
            ▾
          </span>
        </>
      }
      items={[
        ...(canChat ? [{ label: "Chat", hint: where, onSelect: onChat }] : []),
        { label: "Item", hint: where, onSelect: () => onNew("thread") },
        { label: "Project", hint: where, onSelect: () => onNew("project") },
        { label: "Area", onSelect: () => onNew("area") },
        { label: "Capture to Inbox", onSelect: onCapture },
      ]}
    />
  );
}

/**
 * Move to… for one or many rows (tree selection). One searchable picker; moves
 * run in order and the last one can be undone. Areas can go back to the top.
 */
export function MoveToDialog({ ids, items, onClose, onDone }: { ids: string[]; items: WorkItem[]; onClose: () => void; onDone: (op: UndoOp | null) => void }) {
  const { toast } = useToast();
  const moving = items.filter((i) => ids.includes(i.id));
  const move = useWorkMutation(
    async (parentId: string | null) => {
      let op: UndoOp | null = null;
      let failed = 0;
      for (const i of moving) {
        if (i.parentId === parentId) continue;
        try {
          const r = await api.post<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(i.id)}/move`, { parentId });
          op = r.op ?? op;
        } catch (e) {
          failed++;
          if (moving.length === 1) throw e;
        }
      }
      return { op, failed };
    },
    {
      onSuccess: (r) => {
        if (r.failed) toast(`${r.failed} couldn't move (only areas sit at the top level)`, "warn");
        else toast(moving.length > 1 ? `Moved ${moving.length}` : "Moved", "ok");
        onDone(r.op);
      },
    },
  );
  const title = moving.length === 1 ? `Move ${moving[0]!.title}` : `Move ${moving.length} items`;
  return (
    <DestinationPicker
      title={title}
      description="Moving changes placement only; history and lineage are kept."
      items={items}
      exclude={new Set(ids)}
      allowTop={moving.every((i) => i.kind === "area" && i.parentId !== null)}
      busy={move.isPending}
      onClose={onClose}
      onPick={(id) => move.mutate(id)}
    />
  );
}

/**
 * The Areas overview (centre on desktop, under the tree on phones): every
 * area with its progress, plus unfiled conversations to triage in bulk.
 */
export function AreasOverview({ items, onSelect, onNewArea }: { items: WorkItem[]; onSelect: (id: string) => void; onNewArea: () => void }) {
  const areas = items.filter((i) => i.parentId === null && !i.archived);
  return (
    <div className="space-y-4">
      <section aria-labelledby="areas-overview" className="hidden lg:block">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="areas-overview" className="text-[19px] leading-tight font-semibold tracking-tight">
            Areas
          </h2>
          <Button size="sm" onClick={onNewArea}>
            + Area
          </Button>
        </div>
        <ul className="wk-node-rows overflow-hidden rounded-[10px] border border-line bg-surface">
          {areas.map((a) => {
            const r = rollup(items, a.id);
            return (
              <li key={a.id}>
                <button type="button" className="wk-node-row" onClick={() => onSelect(a.id)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{a.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {r.containers} project{r.containers === 1 ? "" : "s"} · {r.open} open
                      {r.conversations ? ` · ${r.conversations} chat${r.conversations === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                  {r.active ? <span className="text-xs text-accent">{r.active} active</span> : null}
                  {r.proofDue ? <span className="text-xs text-warn">{r.proofDue} proof due</span> : null}
                  <Progress done={r.done} total={r.total} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <UnfiledTriage items={items} />
    </div>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`${done} of ${total} done`}>
      <span className="wk-prog" aria-hidden="true">
        <i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
      </span>
      <span className="w-9 text-right text-[11.5px] text-muted tabular-nums">{total ? `${done}/${total}` : "—"}</span>
    </span>
  );
}

/**
 * Unfiled conversations with their suggested home: tick several, then
 * "Accept suggestions" or "File to…" (one picker for all of them).
 */
export function UnfiledTriage({ items }: { items: WorkItem[] }) {
  const q = useQuery({
    queryKey: ["work", "unfiled"],
    queryFn: () => api.get<UnfiledResponse>("/api/work/conversations/unfiled"),
    refetchInterval: pollWhileUpdating,
  });
  const { toast } = useToast();
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const [filing, setFiling] = useState<UnfiledConversation[] | null>(null);
  const list = q.data?.conversations ?? [];
  const shown = all ? list : list.slice(0, 8);
  const file = useWorkMutation(
    async (jobs: { sessionId: string; itemId: string | null }[]) => {
      let ok = 0;
      for (const j of jobs) {
        await api.post("/api/work/conversations/file", j);
        ok++;
      }
      return ok;
    },
    {
      onSuccess: (n) => {
        toast(n === 1 ? "Filed" : `Filed ${n}`, "ok");
        setPicked(new Set());
        setFiling(null);
      },
    },
  );
  const chosen = list.filter((c) => picked.has(c.id));
  const withSuggestion = chosen.filter((c) => c.suggestions[0]);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <section aria-labelledby="unfiled-triage" className="wk-card min-w-0 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 id="unfiled-triage" className="wk-label">
          Unfiled conversations{q.data ? ` · ${q.data.total}` : ""}
        </h2>
        {list.length ? (
          <Button size="sm" variant="ghost" onClick={() => setPicked(picked.size === shown.length ? new Set() : new Set(shown.map((c) => c.id)))}>
            {picked.size && picked.size === shown.length ? "Select none" : "Select all"}
          </Button>
        ) : null}
      </div>
      {q.isPending ? <Spinner label="Loading conversations…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      <UpdatingNote data={q.data} className="mb-2" />
      {q.data && !list.length ? <p className="text-sm text-muted">Every recent conversation is filed.</p> : null}
      <ul className="wk-rows">
        {shown.map((c) => {
          const top = c.suggestions[0];
          return (
            <li key={c.id} className="flex items-center gap-2.5 py-1.5" data-unfiled-row={c.id}>
              <input type="checkbox" className="h-4 w-4 shrink-0" aria-label={`Select ${c.title}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="min-w-0 flex-1">
                <Link href={`/chat/${encodeURIComponent(c.id)}`} className="block truncate text-[13.5px] font-medium hover:underline">
                  {c.title}
                </Link>
                <span className="block truncate text-xs text-muted">
                  {top ? `→ ${top.title}` : "No suggestion"} · {fmtWhen(c.lastActiveAt)}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setFiling([c])} aria-label={`File to…: ${c.title}`}>
                File…
              </Button>
            </li>
          );
        })}
      </ul>
      {list.length > 8 ? (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${list.length}`}
        </Button>
      ) : null}
      {picked.size ? (
        <div className="wk-bulk mt-2" role="region" aria-label="Selected conversations">
          <span className="mr-auto">{picked.size} selected</span>
          <Button size="sm" onClick={() => setFiling(chosen)}>
            File to…
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!withSuggestion.length}
            busy={file.isPending}
            onClick={() => file.mutate(withSuggestion.map((c) => ({ sessionId: c.id, itemId: c.suggestions[0]!.id })))}
          >
            Accept suggestions{withSuggestion.length !== picked.size ? ` (${withSuggestion.length})` : ""}
          </Button>
        </div>
      ) : null}
      {filing ? (
        <DestinationPicker
          title={filing.length === 1 ? `File ${filing[0]!.title}` : `File ${filing.length} conversations`}
          description="Puts the conversations under what you pick in the Areas tree. Nothing in them changes."
          items={items}
          suggested={dedupe(
            filing.flatMap((c) => c.suggestions.map((s) => ({ id: s.id, why: s.matched.length ? `“${s.matched.slice(0, 2).join("”, “")}”` : undefined }))),
          )}
          busy={file.isPending}
          onClose={() => setFiling(null)}
          onPick={(id) => file.mutate(filing.map((c) => ({ sessionId: c.id, itemId: id })))}
          extra={
            <Button size="sm" variant="ghost" onClick={() => file.mutate(filing.map((c) => ({ sessionId: c.id, itemId: null })))}>
              File in Miscellaneous
            </Button>
          }
        />
      ) : null}
    </section>
  );
}

function dedupe<T extends { id: string }>(xs: T[]) {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** A child row on a container page: project (progress), work (status) or conversation. */
export function NodeRow({ i, items, onSelect, status }: { i: WorkItem; items: WorkItem[]; onSelect: (i: WorkItem) => void; status: React.ReactNode }) {
  const r = i.kind === "project" ? rollup(items, i.id) : null;
  return (
    <button type="button" className="wk-node-row" onClick={() => onSelect(i)} data-node-row={i.id}>
      {i.kind === "project" ? <ProjectIcon /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{i.title}</span>
        {i.nextAction ? <span className="block truncate text-xs text-muted">Next: {i.nextAction}</span> : null}
      </span>
      {r ? <Progress done={r.done} total={r.total} /> : status}
    </button>
  );
}
