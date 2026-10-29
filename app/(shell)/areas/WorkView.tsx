"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { addDays, daysBetween } from "@/lib/time";
import { SectionHeader } from "@/components/ui/kit";
import { Badge, Button, ButtonLink, Card, Dialog, Empty, ErrorNote, Field, OverflowMenu, Spinner, inputCls, useToast, type MenuItem } from "@/components/ui";
import { useAccess } from "@/components/access";
import { Markdown } from "@/components/markdown/Markdown";
import { WorkTree } from "@/components/work/WorkTree";
import { ChevronIcon } from "@/components/icons";
import { AreasNav, Block, StatusBadge, fmtDate, useGithubAutoRefresh, useWorkMutation } from "@/components/work/common";
import { AreaSettingsCard } from "@/components/areas/AreaSettings";
import { NodeAgentChip } from "@/components/agents/NodeAgentChip";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { ContinueDialog } from "@/components/work/ContinueDialog";
import { WorkflowSurface } from "@/components/smart/WorkflowSurface";
import { useSmartSettings } from "@/components/smart/AssistantText";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { ConversationLinkDialog, fmtWhen, itemPaths, useConversations } from "@/components/work/conversations";
import { InlineAdd, QuickAddDialog } from "@/components/work/QuickAdd";
import { AreasOverview, MoveToDialog, NewMenu, NodeRow } from "@/components/work/structure";
import { TodayView, useInbox } from "@/components/work/today";
import { CaptureDialog, InboxView } from "@/components/work/inbox";
import { ActionSheet, JobChip, ReportsSection, useAiMenuItems } from "@/components/work/ai/AiActions";
import type { AiActionKind } from "@/lib/ai";
import {
  areaValidationDefault,
  COMPARATORS,
  isClosed,
  isContainer,
  KIND_LABELS,
  handoffMarkdown,
  primaryAction,
  rollup,
  todayIso,
  STATUS_LABELS,
  WORK_STATUSES,
  type Comparator,
  type CreatableKind,
  type DependencyRef,
  type ItemsResponse,
  type ValidationTemplate,
  type LinkKind,
  type WorkDetail,
  type WorkItem,
  type WorkLink,
  type WorkStatus,
  type WorkValidation,
} from "@/lib/work";

const KIND_LABEL = KIND_LABELS;
const textareaCls = `${inputCls} min-h-24`;

function useItems(archived: boolean) {
  return useQuery({ queryKey: ["work", "items", archived], queryFn: () => api.get<ItemsResponse>(`/api/work/items${archived ? "?archived=1" : ""}`) });
}

export type WorkViewKind = "today" | "inbox" | "tree";
type View = { kind: "today" } | { kind: "inbox" } | { kind: "tree" } | { kind: "item"; id: string; action?: string };

/**
 * /areas (Command Center workbench, design Direction C). Desktop: a full-width
 * workbench with the left pane (one nav row + the area tree), the centre
 * (Today, Inbox, the Areas overview or a node's page) and, when there's room,
 * a context rail. Phones: Today/Inbox put the content first and the tree
 * below; "Areas" puts the tree (where structure is built) first.
 *
 * Node pages are type-aware (docs/work.md "Areas structure"): areas and
 * projects are containers (children, progress, quick add); threads,
 * investigations and notes get the work page (validation, packet, PRs).
 */
export function WorkView({
  initialItem,
  initialView,
  initialAction,
  initialCapture,
}: {
  initialItem?: string;
  initialView?: WorkViewKind;
  initialAction?: string;
  /** the share target's text: opens the capture sheet prefilled */
  initialCapture?: string;
}) {
  const router = useRouter();
  const { can } = useAccess();
  const { toast } = useToast();
  const canChat = can("hermes.chat");
  const newChat = useAskHermes();
  const [archived, setArchived] = useState(false);
  const items = useItems(archived);
  const [view, setView] = useState<View>(initialItem ? { kind: "item", id: initialItem, action: initialAction } : { kind: initialView ?? "today" });
  const [adding, setAdding] = useState<{ kind?: CreatableKind; parent: WorkItem | null } | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [capturing, setCapturing] = useState<boolean | string>(initialCapture ? initialCapture : false);
  const inbox = useInbox();
  const [undo, setUndo] = useState<UndoOp | null>(null);
  const clearUndo = useCallback(() => setUndo(null), []);
  const onOp = useCallback((op: UndoOp | null | undefined) => {
    if (op) setUndo(op);
  }, []);
  const place = useWorkMutation(
    (v: { id: string; parentId: string | null; index: number }) =>
      api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(v.id)}/place`, { parentId: v.parentId, index: v.index }),
    { onSuccess: (r) => onOp(r.op) },
  );
  const rename = useWorkMutation((v: { id: string; title: string }) => api.patch(`/api/work/items/${encodeURIComponent(v.id)}`, { title: v.title }), {
    ok: "Renamed",
  });
  const bulkArchive = useWorkMutation(
    async (ids: string[]) => {
      let n = 0;
      for (const id of ids)
        try {
          await api.patch(`/api/work/items/${encodeURIComponent(id)}`, { archived: true });
          n++;
        } catch {
          /* e.g. Miscellaneous is built in */
        }
      return { n, failed: ids.length - n };
    },
    {
      onSuccess: ({ n, failed }) => {
        toast(failed ? `Archived ${n}; ${failed} couldn't be archived` : `Archived ${n}`, failed ? "warn" : "ok");
        setSelection(new Set());
        setSelectMode(false);
      },
    },
  );

  const go = (next: View) => {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    url.searchParams.delete("view");
    url.searchParams.delete("do");
    if (next.kind === "item") url.searchParams.set("item", next.id);
    else if (next.kind !== "today") url.searchParams.set("view", next.kind);
    window.history.replaceState(null, "", url);
    // Phones: the content sits above the tree, so bring it into view.
    if (next.kind !== "tree" && window.matchMedia?.("(max-width: 1023px)").matches) document.getElementById("work-content")?.scrollIntoView({ block: "start" });
  };
  const openConversation = (sessionId: string) => router.push(`/chat/${encodeURIComponent(sessionId)}`);
  const select = (id: string) => {
    const it = items.data?.items.find((i) => i.id === id);
    if (it?.kind === "conversation" && it.sessionId && canChat) openConversation(it.sessionId);
    else go({ kind: "item", id });
  };
  const openWith = (id: string, action?: string) => go({ kind: "item", id, action });

  const wide = useWide();
  const list = items.data?.items ?? [];
  const current = view.kind === "item" && list.some((i) => i.id === view.id) ? view.id : null;
  const inboxCount = inbox.data?.count;
  // "+ New" creates where you are: inside the open area/project, or next to the open item.
  const open = current ? list.find((i) => i.id === current) : undefined;
  const contextNode = open ? (isContainer(open) ? open : (list.find((i) => i.id === open.parentId) ?? null)) : null;

  return (
    <div className="wk-hub flex min-w-0 flex-col lg:grid lg:grid-rows-[auto_1fr]">
      <div className="min-w-0 px-3 pt-3 pb-2 lg:col-start-1 lg:row-start-1 lg:px-2.5 lg:pb-1">
        <header className="mb-2 flex items-center justify-between gap-2 px-1">
          <h1 className="text-lg leading-tight font-semibold tracking-tight lg:text-[15px]">Areas</h1>
          <NewMenu
            canChat={canChat}
            busy={newChat.busy}
            context={contextNode}
            onChat={() => newChat.start(contextNode ? { areaId: contextNode.id } : undefined)}
            onNew={(kind) => setAdding({ kind, parent: kind === "area" ? null : contextNode })}
            onCapture={() => setCapturing(true)}
          />
        </header>
        <AreasNav current={view.kind === "item" ? "tree" : view.kind} inboxCount={inboxCount} onPick={(k) => go({ kind: k })} className="px-1" />
      </div>
      <div id="work-content" className="order-2 min-w-0 scroll-mt-4 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1">
        {view.kind === "today" ? (
          <div className="wk-with-rail min-w-0" data-rail={wide ? "on" : undefined}>
            <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
              <TodayView onOpen={openWith} onInbox={() => go({ kind: "inbox" })} />
            </div>
            {wide ? <TodayRail items={list} onSelect={select} /> : null}
          </div>
        ) : view.kind === "inbox" ? (
          <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
            <InboxView items={list} onOpenItem={select} />
          </div>
        ) : view.kind === "tree" ? (
          <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
            <AreasOverview items={list} onSelect={select} onNewArea={() => setAdding({ kind: "area", parent: null })} />
          </div>
        ) : current ? (
          <ItemDetail
            key={current}
            id={current}
            items={list}
            onSelect={select}
            onOp={onOp}
            initialAction={view.kind === "item" ? view.action : undefined}
            onAdd={(kind, parent) => setAdding({ kind, parent })}
            onMove={(ids) => setMoving(ids)}
          />
        ) : items.isPending || items.isFetching ? (
          <div className="p-6">
            <Spinner label="Loading…" />
          </div>
        ) : (
          <div className="p-6">
            <Empty title="That item isn't here">It may be archived or belong to someone else.</Empty>
          </div>
        )}
      </div>
      <div
        id="work-tree"
        className={`min-w-0 px-3 pb-4 lg:order-none lg:col-start-1 lg:row-start-2 lg:block lg:self-start lg:px-0 lg:pb-0 ${
          view.kind === "tree" ? "order-1" : view.kind === "today" ? "order-3" : "hidden"
        }`}
      >
        <div className="wk-side-sticky min-w-0 rounded-[10px] border border-line bg-surface p-2 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-2.5 lg:pt-1 lg:pb-24">
          <div className="flex items-center justify-between gap-2 px-1 pt-1 pb-1.5 lg:pt-2">
            <h2 className="wk-label">Areas</h2>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={selectMode}
              onClick={() => {
                setSelectMode((m) => !m);
                setSelection(new Set());
              }}
              title="Select several rows to move or archive them together"
            >
              {selectMode ? "Done" : "Select"}
            </Button>
          </div>
          {items.error ? <ErrorNote error={items.error} retry={() => items.refetch()} /> : null}
          {items.isPending ? (
            <Spinner label="Loading work…" />
          ) : (
            <WorkTree
              items={list}
              linked={items.data?.linkedConversations}
              selected={current}
              onSelect={select}
              onOpenConversation={canChat ? openConversation : undefined}
              onPlace={(id, parentId, index) => place.mutate({ id, parentId, index })}
              onCreated={() => toast("Added", "ok")}
              onRename={(id, title) => rename.mutate({ id, title })}
              onMove={(id) => setMoving([id])}
              selectMode={selectMode}
              selection={selection}
              onToggleSelect={(id) => {
                setSelectMode(true);
                setSelection((s) => {
                  const n = new Set(s);
                  if (n.has(id)) n.delete(id);
                  else n.add(id);
                  return n;
                });
              }}
            />
          )}
          {selection.size ? (
            <div className="wk-bulk mt-2" role="region" aria-label="Selection">
              <span className="mr-auto">{selection.size} selected</span>
              <Button size="sm" onClick={() => setMoving([...selection])}>
                Move to…
              </Button>
              <Button size="sm" busy={bulkArchive.isPending} onClick={() => bulkArchive.mutate([...selection])}>
                Archive
              </Button>
              <Button size="sm" variant="ghost" className="text-inherit" onClick={() => setSelection(new Set())}>
                Clear
              </Button>
            </div>
          ) : null}
          <p className="mt-2 hidden px-1 text-[11px] text-muted lg:block">Alt+→/← indent/outdent · Alt+↑/↓ reorder · F2 rename · M move · ⌘-click select</p>
          <label className="mt-2 flex min-h-11 items-center gap-2 px-1 text-[13px] text-muted">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
      </div>
      {adding ? (
        <QuickAddDialog parent={adding.parent} kind={adding.kind} items={list} onClose={() => setAdding(null)} onCreated={(i) => select(i.id)} />
      ) : null}
      {moving ? (
        <MoveToDialog
          ids={moving}
          items={list}
          onClose={() => setMoving(null)}
          onDone={(op) => {
            setMoving(null);
            setSelection(new Set());
            setSelectMode(false);
            onOp(op);
          }}
        />
      ) : null}
      {capturing ? <CaptureDialog initialText={typeof capturing === "string" ? capturing : undefined} onClose={() => setCapturing(false)} /> : null}
      {undo ? <UndoBar key={undo.id} op={undo} onDone={clearUndo} /> : null}
    </div>
  );
}

const OPEN_STATUSES = new Set<WorkStatus>(["captured", "exploring", "ready", "in_progress", "in_review", "awaiting_validation", "ready_to_settle", "reopened"]);

/** Today's context rail (wide screens): what's due soon, what's parked, and the keys. Read from the tree, no extra request. */
function TodayRail({ items, onSelect }: { items: WorkItem[]; onSelect: (id: string) => void }) {
  const today = todayIso();
  const soonLimit = addDays(today, 14);
  const live = items.filter((i) => !i.archived && i.parentId !== null);
  const soon = live
    .filter((i) => OPEN_STATUSES.has(i.status) && i.targetDate && i.targetDate >= today && i.targetDate <= soonLimit)
    .sort((a, b) => (a.targetDate! < b.targetDate! ? -1 : 1))
    .slice(0, 6);
  const parked = live.filter((i) => i.status === "on_hold").slice(0, 5);
  const row = (i: WorkItem, meta: string) => (
    <li key={i.id} className="flex items-baseline justify-between gap-2 py-1">
      <button type="button" className="min-w-0 truncate text-left text-[13px] text-accent hover:underline" onClick={() => onSelect(i.id)}>
        {i.title}
      </button>
      <span className="shrink-0 text-xs text-muted tabular-nums">{meta}</span>
    </li>
  );
  return (
    <aside aria-label="Today context" className="wk-rail flex min-w-0 flex-col gap-3 p-3.5">
      <Block label="Due in the next 14 days">
        {soon.length ? <ul>{soon.map((i) => row(i, shortDate(i.targetDate!)))}</ul> : <p className="text-[13px] text-muted">Nothing due soon.</p>}
      </Block>
      <Block label="On hold">{parked.length ? <ul>{parked.map((i) => row(i, ""))}</ul> : <p className="text-[13px] text-muted">Nothing parked.</p>}</Block>
      <Block label="Keys">
        <p className="text-[13px] leading-6 text-muted">
          <kbd className="wk-kbd">Ctrl K</kbd> jump or do · <kbd className="wk-kbd">/</kbd> search · <kbd className="wk-kbd">↑</kbd>
          <kbd className="wk-kbd">↓</kbd> tree · <kbd className="wk-kbd">←</kbd>
          <kbd className="wk-kbd">→</kbd> fold
        </p>
      </Block>
    </aside>
  );
}

/**
 * The context rails need room: they only exist when the centre column keeps at
 * least 640px beside them (content area ≥ 928px = 640 + the 288px rail). That
 * follows the real content width, not the viewport, so an expanded app rail or
 * a narrow window drops the context rail instead of squeezing the workspace.
 * Below that they aren't rendered at all (not just hidden), so their summaries
 * never duplicate the item's own text for assistive tech.
 */
const RAIL_MIN_CONTENT = 640 + 288; // keep in sync with --wk-rail (work.css)
const subscribeWide = (cb: () => void) => {
  const el = document.getElementById("work-content");
  const ro = typeof ResizeObserver === "undefined" || !el ? null : new ResizeObserver(cb);
  if (el) ro?.observe(el);
  window.addEventListener("resize", cb);
  return () => {
    ro?.disconnect();
    window.removeEventListener("resize", cb);
  };
};
function useWide() {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia("(min-width: 1024px)").matches && (document.getElementById("work-content")?.clientWidth ?? 0) >= RAIL_MIN_CONTENT,
    () => false,
  );
}

const PHONE = "(max-width: 1023px)";
const subscribePhone = (cb: () => void) => {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** Phones and small tablets (no app rail): secondary item sections fold into disclosures. */
function usePhone() {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

/**
 * A secondary item section. Desktop: a compact card with its heading and
 * actions. Phones: a disclosure (summary shows a one-line status) so the item
 * page leads with the next action, actions and validation.
 */
function Section({
  title,
  meta,
  aside,
  phone,
  open,
  onToggle,
  testId,
  children,
}: {
  title: string;
  meta?: ReactNode;
  aside?: ReactNode;
  phone: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  testId?: string;
  children: ReactNode;
}) {
  if (phone)
    return (
      <details className="card wk-disclosure" open={open} onToggle={(e) => onToggle(e.currentTarget.open)} data-testid={testId}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 select-none">
          <ChevronIcon className="wk-disclosure-chev h-4 w-4 shrink-0 text-muted" />
          <h3 className="font-semibold">{title}</h3>
          {meta ? <span className="ml-auto min-w-0 truncate text-xs text-muted">{meta}</span> : null}
        </summary>
        <div className="pt-1">
          {aside ? <div className="mb-2 flex flex-wrap gap-2">{aside}</div> : null}
          {children}
        </div>
      </details>
    );
  return (
    <Card data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-baseline gap-2 font-semibold">
          {title}
          {meta ? <span className="text-xs font-normal text-muted">{meta}</span> : null}
        </h3>
        {aside ? <div className="flex flex-wrap items-center gap-2">{aside}</div> : null}
      </div>
      {children}
    </Card>
  );
}

const RAIL_RELATION: Record<string, string> = {
  forked_from: "↖ Forked from",
  split_from: "↖ Split from",
  moved_from: "↖ Moved from",
  handoff_from: "↖ Follow-up of",
};
const CMP_TEXT: Record<string, string> = { "<=": "≤", ">=": "≥", "<": "<", ">": ">", "=": "=" };
const V_STATE: Record<string, { text: string; s: WorkStatus }> = {
  pass: { text: "passing", s: "settled" },
  fail: { text: "failing", s: "reopened" },
  pending: { text: "pending", s: "awaiting_validation" },
  waived: { text: "waived", s: "on_hold" },
};

function prRef(l: WorkLink) {
  const m = l.url?.match(/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/);
  return m ? { repo: m[2]!, number: m[3]! } : null;
}

/**
 * The item's context rail (wide screens, design Direction C): validation, PR,
 * lineage, dates and conversations, always visible next to the workspace.
 * Read-only summaries; every action stays in the workspace itself.
 */
function ItemRail({ d, onSelect, onShowValidations }: { d: WorkDetail; onSelect: (id: string) => void; onShowValidations: () => void }) {
  const { item } = d;
  const prs = d.links.filter((l) => l.kind === "github_pr" || l.kind === "github_issue");
  const convs = d.links.filter((l) => l.kind === "chat_session");
  const lineage = d.lineage
    .map((l) => {
      const mine = l.childId === item.id;
      const otherId = mine ? l.parentId : l.childId;
      const otherTitle = mine ? l.parentTitle : l.childTitle;
      if (!mine && l.relation === "moved_from") return null;
      const text = mine ? RAIL_RELATION[l.relation] : `↘ ${(RAIL_RELATION[l.relation] ?? "").replace(/^↖ /, "").replace(/ (from|of)$/, "")} into`;
      return otherId && otherTitle ? { id: l.id, otherId, otherTitle, text } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 6);
  const open = d.validations.filter((v) => v.status === "pending" || v.status === "fail").length;
  return (
    <aside aria-label="Item context" className="wk-rail flex min-w-0 flex-col gap-3 p-3.5" data-testid="item-rail">
      <Block
        label="Validation"
        aside={
          d.validations.length ? (
            <button type="button" className="text-xs text-accent hover:underline" onClick={onShowValidations}>
              {open ? "Record results" : "Show all"}
            </button>
          ) : null
        }
      >
        {d.validations.length ? (
          <ul className="space-y-1.5">
            {d.validations.slice(0, 5).map((v) => (
              <li key={v.id} className="flex items-start justify-between gap-2 text-[13px]">
                <span className="min-w-0 break-words">
                  {v.metric} {CMP_TEXT[v.comparator]} {v.threshold}
                  {v.unit ? ` ${v.unit}` : ""}
                  {v.overdue ? <span className="block text-xs font-medium text-danger">overdue · due {shortDate(v.dueDate!)}</span> : null}
                  {!v.overdue && v.dueDate && v.status === "pending" ? <span className="block text-xs text-muted">due {shortDate(v.dueDate)}</span> : null}
                </span>
                <span className="status-pill shrink-0 text-[11px]" data-s={V_STATE[v.status]?.s}>
                  {V_STATE[v.status]?.text ?? v.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p className="text-[13px] text-muted">{d.settle.allowed ? "None declared." : "Settling needs a declared measurement."}</p>
            <button type="button" className="mt-1 text-xs text-accent hover:underline" onClick={onShowValidations}>
              Declare one
            </button>
          </>
        )}
      </Block>
      {prs.length ? (
        <Block label="Pull requests">
          <ul className="space-y-2">
            {prs.map((l) => {
              const ref = prRef(l);
              // Auto titles ("owner/repo#123") repeat the reference: show "#123 repo" instead.
              const named =
                l.title && l.title !== l.targetId && !/^[\w.-]+\/[\w.-]+#\d+$/.test(l.title) ? l.title.replace(/^#\d+\s*[:·-]?\s*/, "") || null : null;
              return (
                <li key={l.id} className="text-[13px]">
                  <div className="flex items-start justify-between gap-2">
                    <a
                      href={l.url ?? "#"}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="min-w-0 break-words hover:underline"
                      aria-label={`${l.kind === "github_pr" ? "Pull request" : "Issue"} ${ref ? `${ref.repo} number ${ref.number}` : ""}${named ? `, ${named}` : ""} (opens in a new tab)`}
                    >
                      <span className="font-mono text-xs font-semibold">#{ref?.number ?? "?"}</span> {named ?? ref?.repo ?? ""}
                    </a>
                    {l.externalState ? (
                      <span
                        className="status-pill shrink-0 text-[11px]"
                        data-s={l.externalState === "merged" ? "settled" : l.externalState === "open" ? "in_review" : "on_hold"}
                      >
                        {l.externalState}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted">
                    {ref && named ? `${ref.repo} · ` : ""}
                    {l.role}
                    {l.checkedAt ? ` · ${l.checkError ? "check failed" : "checked"} ${fmtWhen(l.checkedAt)}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </Block>
      ) : null}
      {lineage.length ? (
        <Block label="Lineage">
          <ul className="space-y-1 text-[13px]">
            {lineage.map((l) => (
              <li key={l.id}>
                <span className="text-muted">{l.text}</span>{" "}
                <button
                  type="button"
                  className="text-left text-accent underline-offset-2 hover:underline"
                  aria-label={`${l.text.replace(/^[↖↘] /, "")} ${l.otherTitle}`}
                  onClick={() => onSelect(l.otherId)}
                >
                  {l.otherTitle}
                </button>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
      <Block label="Dates">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
          <dt className="text-muted">Planned</dt>
          <dd>
            {item.startDate || item.targetDate
              ? `${item.startDate ? shortDate(item.startDate) : "—"} → ${item.targetDate ? shortDate(item.targetDate) : "—"}`
              : "Not planned"}
          </dd>
          {item.completedAt ? (
            <>
              <dt className="text-muted">Closed</dt>
              <dd>{shortDate(item.completedAt)}</dd>
            </>
          ) : null}
          {d.blockedBy.length ? (
            <>
              <dt className="text-muted">Waits on</dt>
              <dd>
                {d.blockedBy.filter((b) => b.open).length} open of {d.blockedBy.length}
              </dd>
            </>
          ) : null}
        </dl>
      </Block>
      {convs.length ? (
        <Block label="Conversations">
          <ul className="space-y-1 text-[13px]">
            {convs.map((l) => (
              <li key={l.id} className="min-w-0">
                <Link
                  href={`/chat/${encodeURIComponent(l.targetId ?? "")}`}
                  className="block truncate text-accent hover:underline"
                  aria-label={`Chat: ${l.title || l.targetId}`}
                >
                  {l.title || <span className="font-mono text-xs">{l.targetId}</span>}
                </Link>
                <span className="text-xs text-muted">{l.role}</span>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
    </aside>
  );
}

/** The summary, shown once (the details form no longer repeats it): two lines, "More" when it runs longer. */
function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 150 || text.includes("\n");
  return (
    <div className="mt-1 flex max-w-[78ch] items-end gap-2">
      <p className={`min-w-0 flex-1 text-[13.5px] leading-[1.45] text-muted ${open ? "whitespace-pre-wrap" : "line-clamp-2"}`}>{text}</p>
      {long ? (
        <button
          type="button"
          className="shrink-0 text-[12.5px] font-medium text-accent hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

/** The next-action strip, edited in place: Edit → input, Enter saves, Esc cancels. */
function NextActionStrip({ value, busy, onSave }: { value: string; busy: boolean; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null)
    return (
      <form
        className="wk-next"
        data-editing=""
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() !== value) onSave(draft.trim());
          setDraft(null);
        }}
      >
        <span className="wk-label shrink-0">Next action</span>
        <input
          aria-label="Edit next action"
          className="wk-next-input"
          autoFocus
          value={draft}
          placeholder="The very next concrete step"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDraft(null);
          }}
        />
        <span className="flex shrink-0 gap-1">
          <Button type="submit" size="sm" variant="primary" busy={busy}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </span>
      </form>
    );
  return (
    <div className="wk-next">
      <span className="wk-label wk-next-label shrink-0">Next action</span>
      <p className="min-w-0 flex-1 text-[14px] break-words">{value || <span className="text-muted">Not set: add the very next step</span>}</p>
      <button type="button" className="wk-next-edit" onClick={() => setDraft(value)} aria-label="Edit next action">
        Edit
      </button>
    </div>
  );
}

function shortDate(d: string) {
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

type DialogKind = null | "fork" | "split" | "packet" | "settle" | "reopen" | "continue" | LinkKind;

type OnOp = (op: UndoOp | null | undefined) => void;

/**
 * A node's page. Containers (areas, projects) get an overview: progress,
 * children with inline add, recent changes; areas keep their settings behind
 * a disclosure. Work (threads, investigations, notes, conversations) gets the
 * workspace: one context-aware primary action, chat, and everything else in ⋯.
 */
function ItemDetail({
  id,
  items,
  onSelect,
  onOp,
  initialAction,
  onAdd,
  onMove,
}: {
  id: string;
  items: WorkItem[];
  onSelect: (id: string) => void;
  onOp: OnOp;
  /** from the command palette / Today: packet | continue | settle | validate */
  initialAction?: string;
  onAdd: (kind: CreatableKind | undefined, parent: WorkItem) => void;
  onMove: (ids: string[]) => void;
}) {
  const q = useQuery({ queryKey: ["work", "item", id], queryFn: () => api.get<WorkDetail>(`/api/work/items/${encodeURIComponent(id)}`) });
  const [tab, setTab] = useState<"overview" | "activity">("overview");
  const [dialog, setDialog] = useState<DialogKind>(
    initialAction === "packet" ? "packet" : initialAction === "continue" ? "continue" : initialAction === "settle" ? "settle" : null,
  );
  const patch = useWorkMutation((body: Record<string, unknown>) => api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(id)}`, body), {
    onSuccess: (r) => onOp(r.op),
    ok: "Saved",
  });
  const reorder = useWorkMutation(
    (direction: "up" | "down") => api.post<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(id)}/reorder`, { direction }),
    { onSuccess: (r) => onOp(r.op) },
  );
  const close = () => setDialog(null);
  const [aiSheet, setAiSheet] = useState<AiActionKind | null>(
    initialAction?.startsWith("ai:") && ["research", "plan", "schedule", "draft"].includes(initialAction.slice(3))
      ? (initialAction.slice(3) as AiActionKind)
      : null,
  );
  const aiItems = useAiMenuItems(id, setAiSheet);
  const wide = useWide();
  const phone = usePhone();
  const [renaming, setRenaming] = useState<string | null>(null);
  // Phone disclosures (Details, Dependencies, Links). Held here so saving the details form (which
  // remounts it) doesn't fold it; a section opens itself when something is added to it.
  const [sections, setSections] = useState<{ details?: boolean; deps?: boolean; links?: boolean }>({});
  const toggle = (k: "details" | "deps" | "links") => (open: boolean) => setSections((o) => (o[k] === open ? o : { ...o, [k]: open }));
  const counts = q.data ? { links: q.data.links.length, deps: q.data.blockedBy.length + q.data.blocking.length } : null;
  const [seen, setSeen] = useState(counts);
  if (counts && (counts.links !== seen?.links || counts.deps !== seen?.deps)) {
    setSeen(counts);
    if (seen && counts.links > seen.links) setSections((o) => ({ ...o, links: true }));
    if (seen && counts.deps > seen.deps) setSections((o) => ({ ...o, deps: true }));
  }
  // Conversations are Hermes/Claude chats: only offered to people who can chat (the API checks too).
  const canChat = useAccess().can("hermes.chat");
  const newChat = useAskHermes();
  if (dialog === "continue" && !canChat) setDialog(null);
  useGithubAutoRefresh(!!q.data?.githubRefresh && q.data.links.some((l) => l.kind === "github_pr" || l.kind === "github_issue"), id);

  if (q.isPending)
    return (
      <div className="p-6">
        <Spinner label="Loading…" />
      </div>
    );
  if (q.error)
    return (
      <div className="p-6">
        <ErrorNote error={q.error} retry={() => q.refetch()} />
      </div>
    );
  const d = q.data;
  const { item } = d;
  const isArea = item.parentId === null;
  const container = isContainer(item) && item.kind !== "conversation";
  const chat = d.links.find((l) => l.kind === "chat_session");
  const showValidations = () => {
    setTab("overview");
    requestAnimationFrame(() => document.getElementById("work-validations")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const action = primaryAction(d, canChat);
  const reopenable = item.status === "settled" || item.status === "awaiting_validation" || d.validations.some((v) => v.status === "fail");
  const childLabel = isArea ? "Project" : "Item";
  const has = (x: MenuItem | false | null | undefined): x is MenuItem => !!x;
  const menu: MenuItem[] = [
    container || item.kind === "note" ? null : { label: "Add sub-item", onSelect: () => onAdd("thread", item) },
    isArea ? null : { label: "Link PR", onSelect: () => setDialog("github_pr") },
    isArea || !canChat ? null : { label: "Link conversation", onSelect: () => setDialog("chat_session") },
    isArea ? null : { label: "Link URL", onSelect: () => setDialog("url") },
    container && canChat ? { label: "New chat here", onSelect: () => newChat.start({ areaId: item.id }) } : null,
    // A project with no items yet can still be worked directly.
    (item.kind === "project" && !isArea) || (!container && item.kind !== "conversation" && action !== "packet")
      ? { label: d.packets.length ? "Revise work packet" : "Start focused work", onSelect: () => setDialog("packet") }
      : null,
    { label: "Rename", hint: "F2", onSelect: () => setRenaming(item.title), disabled: item.builtIn },
    { label: "Move…", hint: "M", onSelect: () => onMove([item.id]), disabled: item.builtIn },
    { label: "Move up", onSelect: () => reorder.mutate("up") },
    { label: "Move down", onSelect: () => reorder.mutate("down") },
    item.kind === "project" && !isArea
      ? { label: "Convert to item", onSelect: () => patch.mutate({ kind: "thread" }) }
      : !isArea && item.kind !== "conversation"
        ? { label: "Convert to project", onSelect: () => patch.mutate({ kind: "project" }) }
        : null,
    isArea ? null : { label: "Fork", onSelect: () => setDialog("fork") },
    container ? null : { label: "Split into child", onSelect: () => setDialog("split") },
    !container && reopenable && action !== "reopen" ? { label: "Reopen", onSelect: () => setDialog("reopen") } : null,
    ...(container ? [] : aiItems),
    {
      label: item.archived ? "Unarchive" : "Archive",
      onSelect: () => patch.mutate({ archived: !item.archived }),
      disabled: item.builtIn,
      danger: !item.archived,
    },
  ].filter(has);

  const primary =
    action === "open_chat" && item.sessionId ? (
      <ButtonLink href={`/chat/${encodeURIComponent(item.sessionId)}`} variant="primary" size="sm">
        Open conversation
      </ButtonLink>
    ) : action === "settle" ? (
      <Button size="sm" variant="primary" onClick={() => setDialog("settle")} disabled={!d.settle.allowed} title={d.settle.reason ?? undefined}>
        Settle…
      </Button>
    ) : action === "record" ? (
      <Button size="sm" variant="primary" onClick={showValidations}>
        Record result
      </Button>
    ) : action === "reopen" ? (
      <Button size="sm" variant="primary" onClick={() => setDialog("reopen")}>
        Reopen
      </Button>
    ) : action === "continue" ? (
      <Button size="sm" variant="primary" onClick={() => setDialog("continue")}>
        Continue
      </Button>
    ) : (
      <Button size="sm" variant="primary" onClick={() => setDialog("packet")}>
        Start focused work
      </Button>
    );

  const kids = d.children.filter((c) => !c.archived);
  // "PR merged — settle?" carries the Settle action itself; nothing else repeats it.
  const settlePrompt = item.status === "ready_to_settle" && !container;
  // One status control: the pill is the select (dot + label + caret), not a pill plus a second dropdown.
  const statusSelect = isArea ? null : (
    <span className="inline-flex items-center gap-1" data-status={item.status}>
      <span className="status-pill wk-status-pick" data-s={item.status}>
        <span aria-hidden="true">{STATUS_LABELS[item.status]}</span>
        <ChevronIcon className="h-3 w-3 rotate-90 opacity-70" />
        <label htmlFor="work-status" className="sr-only">
          Status
        </label>
        <select
          id="work-status"
          className="wk-status-native"
          value={item.status}
          onChange={(e) => {
            const to = e.target.value as WorkStatus;
            if (to === "settled") setDialog("settle");
            else if (to === "reopened") setDialog("reopen");
            else patch.mutate({ status: to });
          }}
        >
          {WORK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </span>
      {item.settledKind === "auto" && item.status === "settled" ? <Badge tone="neutral">Auto-settled</Badge> : null}
    </span>
  );

  return (
    <article aria-labelledby="work-item-title" className="min-w-0" data-node-kind={container ? (isArea ? "area" : "project") : "work"}>
      <section className="bg-surface px-3 pt-3 pb-3 sm:px-5 lg:px-6 lg:pt-4">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-0.5 text-xs text-muted">
            {d.breadcrumb.map((b) => (
              <li key={b.id} className="flex items-center gap-0.5">
                <button type="button" className="tap rounded px-1 hover:text-accent hover:underline" onClick={() => onSelect(b.id)}>
                  {b.title}
                </button>
                <span aria-hidden="true">›</span>
              </li>
            ))}
            <li aria-current="page" className="wk-kind px-1">
              {isArea ? "Area" : item.kind === "thread" ? "Item" : KIND_LABEL[item.kind]}
            </li>
          </ol>
        </nav>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {renaming !== null ? (
            <form
              className="flex min-w-0 flex-1 basis-60 items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (renaming.trim() && renaming.trim() !== item.title) patch.mutate({ title: renaming.trim() });
                setRenaming(null);
              }}
            >
              <input
                aria-label="Title"
                className={`${inputCls} text-[16px] font-semibold`}
                autoFocus
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
              <Button type="submit" size="sm" variant="primary">
                Save
              </Button>
            </form>
          ) : (
            <h2
              id="work-item-title"
              className="min-w-0 text-lg leading-snug font-semibold tracking-tight break-words lg:text-[21px]"
              onDoubleClick={item.builtIn ? undefined : () => setRenaming(item.title)}
            >
              {item.title}
            </h2>
          )}
          {statusSelect}
          {item.archived ? <Badge>Archived</Badge> : null}
          {d.validations.some((v) => v.overdue) ? <Badge tone="danger">Validation overdue</Badge> : null}
          {d.blockedBy.some((b) => b.open) ? <Badge tone="warn">Blocked</Badge> : null}
          <div className="ml-auto flex items-center gap-1">
            {container ? <ViewSwitch id={item.id} /> : null}
            {container ? (
              <Button size="sm" variant="primary" onClick={() => onAdd(isArea ? "project" : "thread", item)}>
                + {childLabel}
              </Button>
            ) : null}
            <OverflowMenu label="More item actions" items={menu} />
          </div>
        </div>
        {container ? <ContainerMeta d={d} items={items} /> : null}
        {item.summary ? <Summary key={item.id} text={item.summary} /> : null}
        {item.settledReason ? <p className="mt-1 text-[13px] text-muted">{item.settledReason}</p> : null}
        {settlePrompt ? (
          <div
            role="status"
            data-testid="settle-prompt"
            className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-ok bg-ok-soft px-3 py-2 text-[13px]"
          >
            <span className="min-w-0">
              <strong>PR merged — settle?</strong> Nothing needs validating. Jarvis never settles on its own: settle when you&apos;re satisfied.
            </span>
            <Button size="sm" variant="primary" onClick={() => setDialog("settle")} disabled={!d.settle.allowed}>
              Settle now
            </Button>
          </div>
        ) : null}
        {isArea && !item.nextAction ? null : (
          <NextActionStrip key={item.updatedAt} value={item.nextAction} busy={patch.isPending} onSave={(nextAction) => patch.mutate({ nextAction })} />
        )}
        {container ? null : <JobChip itemId={item.id} />}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {container || settlePrompt ? null : primary}
          {canChat && item.kind !== "conversation" ? (
            <Button size="sm" busy={newChat.busy} onClick={() => newChat.start({ areaId: item.id })} title="Starts a conversation filed here">
              Chat here
            </Button>
          ) : null}
          {canChat && item.kind !== "conversation" ? <NodeAgentChip nodeId={item.id} version={item.updatedAt} /> : null}
        </div>
      </section>

      {container ? (
        <ContainerBody d={d} items={items} onSelect={onSelect} phone={phone} sections={sections} toggle={toggle} canChat={canChat} onDialog={setDialog} />
      ) : (
        <div className="wk-with-rail min-w-0" data-rail={wide ? "on" : undefined}>
          <div className="min-w-0">
            <div role="tablist" aria-label="Item sections" className="flex gap-5 border-b border-line bg-surface px-3 sm:px-5 lg:px-6">
              {(
                [
                  ["overview", "Overview"],
                  ["activity", "Activity"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  id={`tab-${k}`}
                  aria-selected={tab === k}
                  aria-controls={`panel-${k}`}
                  tabIndex={tab === k ? 0 : -1}
                  onClick={() => setTab(k)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      const n = k === "overview" ? "activity" : "overview";
                      setTab(n);
                      document.getElementById(`tab-${n}`)?.focus();
                    }
                  }}
                  className="wk-tab"
                >
                  {label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="wk-panel space-y-3 px-3 py-3 sm:px-5 lg:px-6 lg:py-4">
              {tab === "overview" ? (
                <>
                  {(() => {
                    const edit = (
                      <EditItem
                        key={item.updatedAt}
                        item={item}
                        validationDefault={d.validationDefault}
                        phone={phone}
                        open={sections.details ?? false}
                        onToggle={toggle("details")}
                      />
                    );
                    const packet = <PacketCard d={d} onRevise={() => setDialog("packet")} onContinue={canChat ? () => setDialog("continue") : undefined} />;
                    const validations = (
                      <Validations
                        d={d}
                        onSettle={settlePrompt ? undefined : () => setDialog("settle")}
                        onReopen={() => setDialog("reopen")}
                        focusRecord={initialAction === "validate"}
                      />
                    );
                    const children = kids.length ? (
                      <ChildrenCard label="Sub-items" parent={item} list={kids} items={items} onSelect={onSelect} addLabel="Add a sub-item" />
                    ) : null;
                    // Phones lead with proof; desktop with the packet (the rail summarises proof). The details form
                    // folds away everywhere: the header already shows the title, summary and next action.
                    return phone ? (
                      <>
                        {validations}
                        {packet}
                        {children}
                        {edit}
                      </>
                    ) : (
                      <>
                        {packet}
                        {validations}
                        {children}
                        {edit}
                      </>
                    );
                  })()}
                  <Dependencies
                    d={d}
                    items={items}
                    onSelect={onSelect}
                    phone={phone}
                    open={sections.deps ?? d.blockedBy.some((b) => b.open)}
                    onToggle={toggle("deps")}
                  />
                  <Links d={d} canChat={canChat} phone={phone} open={sections.links ?? false} onToggle={toggle("links")} />
                  <ReportsSection itemId={item.id} areaId={d.area?.id ?? null} />
                </>
              ) : (
                <Activity d={d} onSelect={onSelect} />
              )}
            </div>
          </div>
          {wide ? <ItemRail d={d} onSelect={onSelect} onShowValidations={showValidations} /> : null}
        </div>
      )}

      <ForkDialog open={dialog === "fork"} onClose={close} item={item} chat={canChat ? chat : undefined} onCreated={onSelect} onOp={onOp} />
      <SplitDialog open={dialog === "split"} onClose={close} item={item} onCreated={onSelect} onOp={onOp} />
      {dialog === "packet" ? <PacketDialog open onClose={close} d={d} /> : null}
      {dialog === "continue" ? <ContinueDialog d={d} markdown={handoffMarkdown(d, window.location.origin)} onClose={close} /> : null}
      <SettleDialog open={dialog === "settle"} onClose={close} d={d} />
      {aiSheet ? <ActionSheet itemId={item.id} areaId={d.area?.id ?? null} action={aiSheet} onClose={() => setAiSheet(null)} /> : null}
      <ReopenDialog open={dialog === "reopen"} onClose={close} item={item} onFollowUp={onSelect} />
      {dialog === "github_pr" || dialog === "url" ? <LinkDialog kind={dialog} onClose={close} item={item} /> : null}
      {dialog === "chat_session" ? (
        <ConversationLinkDialog
          item={item}
          onClose={close}
          linkedHere={new Set(d.links.filter((l) => l.kind === "chat_session").map((l) => l.targetId ?? ""))}
        />
      ) : null}
    </article>
  );
}

/** Area / project body: progress, children (with inline add), recent changes, settings and details. */
function ContainerBody({
  d,
  items,
  onSelect,
  phone,
  sections,
  toggle,
  canChat,
  onDialog,
}: {
  d: WorkDetail;
  items: WorkItem[];
  onSelect: (id: string) => void;
  phone: boolean;
  sections: { details?: boolean; deps?: boolean; links?: boolean };
  toggle: (k: "details" | "deps" | "links") => (open: boolean) => void;
  canChat: boolean;
  onDialog: (k: DialogKind) => void;
}) {
  const { item } = d;
  const isArea = item.parentId === null;
  const r = rollup(items, item.id);
  const kids = items.filter((i) => i.parentId === item.id && !i.archived);
  const projects = kids.filter((k) => k.kind === "project");
  const rest = kids.filter((k) => k.kind !== "project");
  // Recently changed anywhere below this node.
  const below = new Set<string>([item.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const i of items)
      if (i.parentId && below.has(i.parentId) && !below.has(i.id)) {
        below.add(i.id);
        grew = true;
      }
  }
  below.delete(item.id);
  // Only what the children list doesn't already show: changes deeper down.
  const recent = items
    .filter((i) => below.has(i.id) && i.parentId !== item.id && !i.archived && i.updatedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const usedAsWork = d.packets.length > 0 || d.validations.length > 0;
  return (
    <div className="wk-panel wk-cpage px-3 py-3 sm:px-5 lg:px-6 lg:py-4">
      <div className="wk-cpage-main min-w-0 space-y-3">
        <div className="wk-kpis" aria-label="Progress">
          <div>
            <b>{isArea ? r.containers : `${r.done}/${r.total}`}</b>
            <span>{isArea ? "Projects" : "Done"}</span>
          </div>
          <div>
            <b>{r.open}</b>
            <span>Open</span>
          </div>
          <div>
            <b>{r.active}</b>
            <span>Active</span>
          </div>
          <div>
            <b>{r.proofDue}</b>
            <span>Proof due</span>
          </div>
        </div>
        {isArea ? (
          <>
            <ChildrenCard
              label="Projects"
              parent={item}
              list={projects}
              items={items}
              onSelect={onSelect}
              addLabel={projects.length ? "Add a project" : "Add your first project"}
              addKind="project"
              empty="Projects group related work. Add one, or type a path like “Launch / pricing page”."
            />
            <ChildrenCard
              label="Filed in this area"
              testId="items-chats-here"
              parent={item}
              list={rest}
              items={items}
              onSelect={onSelect}
              addLabel="Add an item"
              addKind="thread"
              empty={canChat ? "Loose items and chats filed straight into this area show here." : "Loose items show here."}
            />
          </>
        ) : (
          <ChildrenCard
            label="Work"
            parent={item}
            list={kids}
            items={items}
            onSelect={onSelect}
            addLabel={kids.length ? "Add item, sub-project or path" : "Add the first item"}
            empty="Break the project into items. Type “Sub-project / item” to nest."
          />
        )}
        {recent.length ? (
          <section aria-labelledby="recent-h">
            <SectionHeader id="recent-h" label="Recent activity" count={recent.length} />
            <ul className="wk-recent">
              {recent.map((i) => (
                <li key={i.id}>
                  <button type="button" className="tap min-w-0 truncate text-left hover:text-accent" onClick={() => onSelect(i.id)}>
                    {i.title}
                  </button>
                  <span className="shrink-0 text-xs text-muted" data-dynamic>
                    {STATUS_LABELS[i.status]} · {fmtWhen(i.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {usedAsWork ? (
          <>
            <PacketCard d={d} onRevise={() => onDialog("packet")} onContinue={canChat ? () => onDialog("continue") : undefined} />
            <Validations d={d} onSettle={() => onDialog("settle")} onReopen={() => onDialog("reopen")} />
          </>
        ) : null}
        <details className="wk-disclosure card">
          <summary className="tap cursor-pointer font-semibold">Activity</summary>
          <div className="mt-2 space-y-3">
            <Activity d={d} onSelect={onSelect} />
          </div>
        </details>
      </div>
      {/* Side column (≥1100): settings, details, dependencies, links, reports. Stacks below on narrower screens. */}
      <aside className="wk-cpage-side min-w-0 space-y-3" aria-label={isArea ? "Area settings and details" : "Project details"}>
        {isArea && !item.builtIn ? <AreaSettingsCard key={`s-${item.updatedAt}`} area={item} /> : null}
        <EditItem
          key={item.updatedAt}
          item={item}
          validationDefault={d.validationDefault}
          phone={phone}
          open={sections.details ?? false}
          onToggle={toggle("details")}
        />
        {isArea ? null : (
          <>
            <Dependencies
              d={d}
              items={items}
              onSelect={onSelect}
              phone={phone}
              open={sections.deps ?? d.blockedBy.some((b) => b.open)}
              onToggle={toggle("deps")}
            />
            <Links d={d} canChat={canChat} phone={phone} open={sections.links ?? false} onToggle={toggle("links")} />
          </>
        )}
        <ReportsSection itemId={item.id} areaId={d.area?.id ?? null} />
      </aside>
    </div>
  );
}

/** One meta line under a container title: what's inside and what's moving (design: agent · validation · settle). */
function ContainerMeta({ d, items }: { d: WorkDetail; items: WorkItem[] }) {
  const { item } = d;
  const isArea = item.parentId === null;
  const r = rollup(items, item.id);
  const parts = [
    isArea ? `${r.containers} ${r.containers === 1 ? "project" : "projects"}` : `${r.done} of ${r.total} done`,
    `${r.open} open`,
    r.active ? `${r.active} active` : null,
    r.proofDue ? `${r.proofDue} need proof` : null,
  ].filter(Boolean);
  return (
    <p className="wk-cmeta" data-dynamic>
      {parts.join(" · ")}
    </p>
  );
}

/** List · Timeline · Map view switch for an area/project (the other views are scoped routes). */
function ViewSwitch({ id }: { id: string }) {
  const q = `?root=${encodeURIComponent(id)}`;
  return (
    <nav aria-label="Views" className="wk-views hidden sm:flex">
      <span aria-current="page" className="wk-view">
        List
      </span>
      <Link href={`/areas/timeline${q}`} className="wk-view">
        Timeline
      </Link>
      <Link href={`/areas/map${q}`} className="wk-view">
        Map
      </Link>
    </nav>
  );
}

/** Children of a node as dense rows; closed work folds away; ends with an inline "+ Add" row. */
function ChildrenCard({
  label,
  parent,
  list,
  items,
  onSelect,
  addLabel,
  addKind,
  empty,
  testId,
}: {
  label: string;
  testId?: string;
  parent: WorkItem;
  list: WorkItem[];
  items: WorkItem[];
  onSelect: (id: string) => void;
  addLabel: string;
  addKind?: CreatableKind;
  empty?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const open = list.filter((i) => !isClosed(i.status) || i.kind === "project" || i.kind === "conversation");
  const done = list.filter((i) => !open.includes(i));
  const rows = showDone ? [...open, ...done] : open;
  const slug = testId ?? label.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <section aria-labelledby={`kids-${slug}`} data-testid={`children-${slug}`}>
      <SectionHeader id={`kids-${slug}`} label={label} count={list.length || undefined} />
      <div className="k-card overflow-hidden">
        {rows.length ? (
          <ul className="wk-node-rows">
            {rows.map((c) => (
              <li key={c.id}>
                <NodeRow
                  i={c}
                  items={items}
                  onSelect={(x) => onSelect(x.id)}
                  status={
                    c.kind === "conversation" ? (
                      <span className="text-xs text-muted" data-dynamic>
                        {fmtWhen(c.updatedAt)}
                      </span>
                    ) : (
                      <StatusBadge status={c.status} auto={c.settledKind === "auto"} />
                    )
                  }
                />
              </li>
            ))}
          </ul>
        ) : !adding && empty ? (
          <p className="px-3 py-2 text-[13px] text-muted">{empty}</p>
        ) : null}
        {done.length ? (
          <button
            type="button"
            className="tap w-full border-t border-line px-3 py-1.5 text-left text-xs text-muted hover:text-text"
            onClick={() => setShowDone((s) => !s)}
          >
            {showDone ? "Hide done" : `${done.length} done · show`}
          </button>
        ) : null}
        <div className="border-t border-line">
          {adding ? (
            <InlineAdd
              parent={parent}
              kind={addKind}
              onDone={() => setAdding(false)}
              placeholder={addKind === "project" ? "Project name, or Project / item…" : undefined}
            />
          ) : (
            <button type="button" className="wk-node-row wk-add-row" onClick={() => setAdding(true)}>
              <span aria-hidden="true" className="wk-plus">
                +
              </span>
              {addLabel}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

type SectionProps = { phone: boolean; open: boolean; onToggle: (open: boolean) => void };

function EditItem({ item, validationDefault, open, onToggle }: { item: WorkItem; validationDefault: WorkDetail["validationDefault"] } & SectionProps) {
  const isArea = item.parentId === null;
  const [f, setF] = useState({
    title: item.title,
    summary: item.summary,
    nextAction: item.nextAction,
    startDate: item.startDate ?? "",
    targetDate: item.targetDate ?? "",
    validationDefault: (item.validationDefault ?? "") as "" | "required" | "optional",
  });
  const save = useWorkMutation(
    () => {
      const { validationDefault: vd, ...rest } = f;
      return api.patch(`/api/work/items/${encodeURIComponent(item.id)}`, {
        ...rest,
        startDate: f.startDate || null,
        targetDate: f.targetDate || null,
        ...(isArea && vd !== (item.validationDefault ?? "") ? { validationDefault: vd || null } : {}),
      });
    },
    { ok: "Saved" },
  );
  const ruleDefault = areaValidationDefault({ ...item, validationDefault: null, systemKey: item.builtIn ? "misc" : null });
  const dirty =
    f.title !== item.title ||
    f.summary !== item.summary ||
    f.nextAction !== item.nextAction ||
    f.startDate !== (item.startDate ?? "") ||
    f.targetDate !== (item.targetDate ?? "") ||
    (isArea && f.validationDefault !== (item.validationDefault ?? ""));
  const planned =
    item.startDate || item.targetDate
      ? `${item.startDate ? shortDate(item.startDate) : "—"} → ${item.targetDate ? shortDate(item.targetDate) : "—"}`
      : "Not planned";
  const saveButton = (
    <Button type="submit" form="wi-form" size="sm" variant="primary" disabled={!dirty} busy={save.isPending}>
      Save details
    </Button>
  );
  return (
    <Section
      title="Details"
      meta={dirty ? "Unsaved changes" : `Planned ${planned === "Not planned" ? "—" : planned}`}
      phone
      open={open}
      onToggle={onToggle}
      testId="work-details"
    >
      {/* A property sheet: label column + quiet inline fields on desktop; stacked on phones. */}
      <form
        id="wi-form"
        className="wk-props"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <label htmlFor="wi-title">Title</label>
        <input id="wi-title" required className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <label htmlFor="wi-next">Next action</label>
        <input
          id="wi-next"
          className={inputCls}
          value={f.nextAction}
          placeholder="The very next concrete step"
          onChange={(e) => setF({ ...f, nextAction: e.target.value })}
        />
        <label htmlFor="wi-summary">Summary</label>
        <textarea
          id="wi-summary"
          rows={2}
          className={`${inputCls} wk-autogrow`}
          value={f.summary}
          placeholder="What this is and why it matters"
          onChange={(e) => setF({ ...f, summary: e.target.value })}
        />
        <span id="wi-dates-label">Planned</span>
        <div role="group" aria-labelledby="wi-dates-label" className="wk-props-dates">
          <label htmlFor="wi-start" className="sr-only">
            Start date
          </label>
          <input id="wi-start" type="date" className={inputCls} value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          <label htmlFor="wi-target" className="sr-only">
            Target date
          </label>
          <input id="wi-target" type="date" className={inputCls} value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />
        </div>
        {isArea ? (
          <>
            <label htmlFor="wi-vdefault">Validation</label>
            <div>
              <select
                id="wi-vdefault"
                className={inputCls}
                aria-describedby="wi-vdefault-hint"
                value={f.validationDefault}
                onChange={(e) => setF({ ...f, validationDefault: e.target.value as "" | "required" | "optional" })}
              >
                <option value="">Default for this area ({ruleDefault === "required" ? "required" : "optional"})</option>
                <option value="required">Required</option>
                <option value="optional">Optional</option>
              </select>
              <p id="wi-vdefault-hint" className="mt-1 text-xs text-muted">
                What “Start focused work” preselects for new packets in this area. You can override it per packet.
              </p>
            </div>
          </>
        ) : (
          <p className="wk-props-note text-xs text-muted" data-testid="validation-default-note">
            New packets here {validationDefault.value === "required" ? "require" : "don't require"} validation by default
            {validationDefault.areaTitle ? ` (set on ${validationDefault.areaTitle})` : ""}.
          </p>
        )}
        <div className="wk-props-note flex justify-end">{saveButton}</div>
      </form>
    </Section>
  );
}

function PacketCard({ d, onRevise, onContinue }: { d: WorkDetail; onRevise: () => void; onContinue?: () => void }) {
  const { toast } = useToast();
  // Client-only: this card renders after the detail query resolves in the browser.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const p = d.packets[0];
  const md = handoffMarkdown(d, origin);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(md);
      toast("Handoff copied", "ok");
    } catch {
      toast("Couldn't copy. Use the preview below.", "warn");
    }
  };
  return (
    <Card className="wk-packet">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="flex items-baseline gap-2 font-semibold">
          Work packet
          {p ? (
            <span className="text-xs font-normal text-muted" data-dynamic>
              v{p.version} · {fmtDate(p.createdAt)}
            </span>
          ) : null}
        </h3>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={copy}>
            Copy handoff
          </Button>
          {p ? (
            <Button size="sm" variant="ghost" onClick={onRevise}>
              New revision
            </Button>
          ) : null}
          {onContinue ? (
            <Button size="sm" onClick={onContinue}>
              Continue in new conversation
            </Button>
          ) : null}
        </div>
      </div>
      {p ? (
        <>
          <dl className="wk-packet-dl">
            <PacketRow label="Objective" value={p.objective} />
            <PacketRow label="In scope" value={p.inScope} />
            <PacketRow label="Out of scope" value={p.outOfScope} />
            <PacketRow label="Acceptance criteria" value={p.acceptanceCriteria} />
            <PacketRow label="Decisions" value={p.decisions} />
            <PacketRow label="Open questions" value={p.openQuestions} />
            <PacketRow label="Context" value={p.context} />
            <PacketRow label="Validation" value={p.validationRequired ? "Required before settling" : `Not required: ${p.noValidationReason ?? ""}`} />
          </dl>
          <p className="sr-only">Packets are immutable; changes make a new version.</p>
          {d.packets.length > 1 ? (
            <details className="mt-2 text-sm">
              <summary className="tap cursor-pointer text-accent">Version history ({d.packets.length})</summary>
              <ol className="mt-2 space-y-2">
                {d.packets.map((v) => (
                  <li key={v.id} className="rounded-lg bg-surface-2 p-2">
                    <span className="font-medium">v{v.version}</span> · {fmtDate(v.createdAt)} · <span className="break-words">{v.objective}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted">No packet yet. Start focused work to write one.</p>
      )}
      <details className="mt-2 text-sm">
        <summary className="tap cursor-pointer text-accent">Preview handoff</summary>
        <pre data-testid="handoff-preview" className="mt-2 max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap">
          {md}
        </pre>
      </details>
    </Card>
  );
}

function PacketRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd className="min-w-0 break-words">
        <Markdown text={value} headingOffset={3} className="md-compact" />
      </dd>
    </>
  );
}

/** `onSettle` undefined: the page's primary action (or the settle prompt) already offers Settle. */
function Validations({ d, onSettle, onReopen, focusRecord }: { d: WorkDetail; onSettle?: () => void; onReopen: () => void; focusRecord?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [templates, setTemplates] = useState(false);
  const failed = d.validations.some((v) => v.status === "fail");
  const overdue = d.validations.filter((v) => v.overdue).length;
  return (
    <Card id="work-validations" className="scroll-mt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-baseline gap-2 font-semibold">
          Validation
          {d.validations.length ? (
            <span className="text-xs font-normal text-muted">
              {d.validations.filter((v) => v.status === "pass" || v.status === "waived").length}/{d.validations.length} met
            </span>
          ) : null}
        </h3>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            Add validation
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setTemplates(true)}>
            Add from template
          </Button>
          {d.item.status !== "settled" && onSettle ? (
            <Button size="sm" variant="primary" disabled={!d.settle.allowed} onClick={onSettle} aria-describedby={d.settle.allowed ? undefined : "settle-why"}>
              Settle
            </Button>
          ) : null}
        </div>
      </div>
      {!d.settle.allowed && d.item.status !== "settled" ? (
        <p id="settle-why" className="mb-2 text-[13px] text-muted">
          {d.settle.reason}
        </p>
      ) : null}
      {failed && d.item.status !== "reopened" ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-danger-soft p-2 text-sm text-danger">
          <span>A validation failed.</span>
          <Button size="sm" onClick={onReopen}>
            Reopen with failed evidence
          </Button>
        </div>
      ) : null}
      {overdue ? (
        <p className="mb-2 rounded-lg bg-danger-soft p-2 text-sm text-danger" data-testid="validation-overdue">
          {overdue} validation{overdue === 1 ? " is" : "s are"} overdue: the due date passed and it&apos;s still pending.
        </p>
      ) : null}
      {adding ? <AddValidation itemId={d.item.id} onDone={() => setAdding(false)} /> : null}
      {templates ? <TemplatesDialog itemId={d.item.id} onClose={() => setTemplates(false)} /> : null}
      {d.validations.length ? (
        <ul className="wk-vlist">
          {d.validations.map((v, i) => (
            <ValidationRow
              key={v.id}
              v={v}
              focus={
                !!focusRecord &&
                i ===
                  Math.max(
                    0,
                    d.validations.findIndex((x) => x.status === "pending" || x.status === "fail"),
                  )
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">None yet. A merged PR isn&apos;t proof the outcome happened: declare what you&apos;ll measure.</p>
      )}
    </Card>
  );
}

function AddValidation({ itemId, onDone }: { itemId: string; onDone: () => void }) {
  const [f, setF] = useState({ metric: "", comparator: "<=" as Comparator, threshold: "", unit: "", baseline: "", dueDate: "" });
  const [asTemplate, setAsTemplate] = useState(false);
  const add = useWorkMutation(
    async () => {
      const r = await api.post(`/api/work/items/${encodeURIComponent(itemId)}/validations`, {
        metric: f.metric,
        comparator: f.comparator,
        threshold: Number(f.threshold),
        unit: f.unit,
        baseline: f.baseline === "" ? null : Number(f.baseline),
        dueDate: f.dueDate || null,
      });
      if (asTemplate)
        await api.post("/api/work/validation-templates", {
          metric: f.metric,
          comparator: f.comparator,
          threshold: Number(f.threshold),
          unit: f.unit,
          // The template keeps the due date as "this many days after it's applied".
          dueOffsetDays: f.dueDate ? Math.max(0, daysBetween(todayIso(), f.dueDate)) : null,
        });
      return r;
    },
    { ok: asTemplate ? "Validation added and saved as a template" : "Validation added", onSuccess: onDone },
  );
  return (
    <form
      className="mb-3 grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined);
      }}
    >
      <Field id="va-metric" label="Metric">
        <input
          id="va-metric"
          required
          className={inputCls}
          value={f.metric}
          onChange={(e) => setF({ ...f, metric: e.target.value })}
          placeholder="p95 hydration"
        />
      </Field>
      <div className="grid grid-cols-[6rem_1fr] gap-2">
        <Field id="va-cmp" label="Comparator">
          <select id="va-cmp" className={inputCls} value={f.comparator} onChange={(e) => setF({ ...f, comparator: e.target.value as Comparator })}>
            {COMPARATORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field id="va-threshold" label="Threshold">
          <input
            id="va-threshold"
            required
            type="number"
            step="any"
            className={inputCls}
            value={f.threshold}
            onChange={(e) => setF({ ...f, threshold: e.target.value })}
          />
        </Field>
      </div>
      <Field id="va-unit" label="Unit">
        <input id="va-unit" className={inputCls} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="ms" />
      </Field>
      <Field id="va-baseline" label="Baseline (optional)">
        <input id="va-baseline" type="number" step="any" className={inputCls} value={f.baseline} onChange={(e) => setF({ ...f, baseline: e.target.value })} />
      </Field>
      <Field id="va-due" label="Due date (optional)">
        <input id="va-due" type="date" className={inputCls} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={asTemplate} onChange={(e) => setAsTemplate(e.target.checked)} />
        Also save as a reusable template
      </label>
      <div className="flex items-end justify-end gap-2 sm:col-span-2">
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" busy={add.isPending}>
          Save validation
        </Button>
      </div>
    </form>
  );
}

function TemplatesDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["work", "templates"], queryFn: () => api.get<{ templates: ValidationTemplate[] }>("/api/work/validation-templates") });
  const [f, setF] = useState({ name: "", metric: "", comparator: "<=" as Comparator, threshold: "", unit: "", dueOffsetDays: "" });
  const apply = useWorkMutation((templateId: string) => api.post(`/api/work/items/${encodeURIComponent(itemId)}/validations/from-template`, { templateId }), {
    ok: "Validation added from template",
    onSuccess: onClose,
  });
  const create = useWorkMutation(
    () =>
      api.post("/api/work/validation-templates", {
        name: f.name || undefined,
        metric: f.metric,
        comparator: f.comparator,
        threshold: Number(f.threshold),
        unit: f.unit,
        dueOffsetDays: f.dueOffsetDays === "" ? null : Number(f.dueOffsetDays),
      }),
    { ok: "Template saved", onSuccess: () => setF({ name: "", metric: "", comparator: "<=", threshold: "", unit: "", dueOffsetDays: "" }) },
  );
  const remove = useWorkMutation((id: string) => api.del(`/api/work/validation-templates/${encodeURIComponent(id)}`), { ok: "Template deleted" });
  const list = q.data?.templates ?? [];
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Add from template"
      description="Your reusable validation contracts. Applying one adds a pending validation."
    >
      {q.isPending ? <Spinner label="Loading templates…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data && !list.length ? (
        <p className="text-sm text-muted">No templates yet. Create one below, or tick “Also save as a reusable template” when adding a validation.</p>
      ) : null}
      {list.length ? (
        <ul aria-label="Validation templates" className="divide-y divide-line rounded-lg border border-line">
          {list.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <div className="min-w-0">
                <p className="font-medium break-words">{t.name}</p>
                <p className="text-xs text-muted">
                  {t.metric} {t.comparator} {t.threshold}
                  {t.unit ? ` ${t.unit}` : ""}
                  {t.dueOffsetDays !== null ? ` · due ${t.dueOffsetDays} day${t.dueOffsetDays === 1 ? "" : "s"} after adding` : " · no due date"}
                </p>
              </div>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="primary"
                  busy={apply.isPending && apply.variables === t.id}
                  onClick={() => apply.mutate(t.id)}
                  aria-label={`Add ${t.name}`}
                >
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(t.id)} aria-label={`Delete template ${t.name}`}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="mt-3 text-sm">
        <summary className="tap cursor-pointer text-accent">New template</summary>
        <form
          className="mt-2 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <Field id="vt-name" label="Name (optional)">
            <input id="vt-name" className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field id="vt-metric" label="Template metric">
            <input id="vt-metric" required className={inputCls} value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })} />
          </Field>
          <div className="grid grid-cols-[6rem_1fr] gap-2">
            <Field id="vt-cmp" label="Comparator">
              <select id="vt-cmp" className={inputCls} value={f.comparator} onChange={(e) => setF({ ...f, comparator: e.target.value as Comparator })}>
                {COMPARATORS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="vt-threshold" label="Threshold">
              <input
                id="vt-threshold"
                required
                type="number"
                step="any"
                className={inputCls}
                value={f.threshold}
                onChange={(e) => setF({ ...f, threshold: e.target.value })}
              />
            </Field>
          </div>
          <Field id="vt-unit" label="Unit">
            <input id="vt-unit" className={inputCls} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
          </Field>
          <Field id="vt-offset" label="Due after (days, optional)">
            <input
              id="vt-offset"
              type="number"
              min={0}
              step={1}
              className={inputCls}
              value={f.dueOffsetDays}
              onChange={(e) => setF({ ...f, dueOffsetDays: e.target.value })}
            />
          </Field>
          <div className="flex items-end justify-end">
            <Button type="submit" size="sm" busy={create.isPending}>
              Save template
            </Button>
          </div>
        </form>
      </details>
    </Dialog>
  );
}

const V_TONE = { pending: "neutral", pass: "ok", fail: "danger", waived: "warn" } as const;

function ValidationRow({ v, focus }: { v: WorkValidation; focus?: boolean }) {
  const [observed, setObserved] = useState(v.observed?.toString() ?? "");
  const [evidence, setEvidence] = useState(v.evidenceUrl ?? "");
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const url = `/api/work/validations/${encodeURIComponent(v.id)}`;
  const record = useWorkMutation(() => api.patch(url, { observed: observed === "" ? null : Number(observed), evidenceUrl: evidence || null }), {
    ok: "Evidence recorded",
  });
  const waive = useWorkMutation(() => api.patch(url, { waive: true, waiverReason: reason }), { ok: "Waived", onSuccess: () => setWaiving(false) });
  const remove = useWorkMutation(() => api.del(url), { ok: "Validation removed" });
  const label = `${v.metric} ${CMP_TEXT[v.comparator] ?? v.comparator} ${v.threshold}${v.unit ? ` ${v.unit}` : ""}`;
  return (
    <li className="wk-vrow" data-overdue={v.overdue || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <p className="min-w-0 font-medium break-words">{label}</p>
        <span className="flex flex-wrap gap-1">
          {v.overdue ? <Badge tone="danger">Overdue</Badge> : null}
          <Badge tone={V_TONE[v.status]}>{v.status === "pass" ? "Pass" : v.status === "fail" ? "Fail" : v.status === "waived" ? "Waived" : "Pending"}</Badge>
        </span>
      </div>
      <p className="text-xs text-muted" data-dynamic>
        {v.baseline !== null ? `Baseline ${v.baseline}${v.unit ? ` ${v.unit}` : ""} · ` : ""}
        {v.observed !== null ? `Observed ${v.observed}${v.unit ? ` ${v.unit}` : ""}` : "Not measured yet"}
        {v.dueDate ? ` · due ${shortDate(v.dueDate)}` : ""}
        {v.waiverReason ? ` · waived: ${v.waiverReason}` : ""}
      </p>
      {v.evidenceUrl ? (
        <a href={v.evidenceUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-accent underline break-all">
          Evidence<span className="sr-only"> for {v.metric} (opens in a new tab)</span>
        </a>
      ) : null}
      <form
        className="wk-vform"
        onSubmit={(e) => {
          e.preventDefault();
          record.mutate(undefined);
        }}
      >
        <div>
          <input
            id={`obs-${v.id}`}
            ref={(el) => {
              // "Record result" from Today or the command palette lands here.
              if (el && focus && document.activeElement !== el && !el.dataset.focused) {
                el.dataset.focused = "1";
                el.scrollIntoView({ block: "center" });
                el.focus({ preventScroll: true });
              }
            }}
            inputMode="decimal"
            aria-label={`Observed value for ${v.metric}`}
            type="number"
            step="any"
            className={inputCls}
            placeholder={`Observed${v.unit ? ` (${v.unit})` : ""}`}
            value={observed}
            onChange={(e) => setObserved(e.target.value)}
          />
        </div>
        <div>
          <input
            id={`ev-${v.id}`}
            type="url"
            aria-label="Evidence link"
            className={inputCls}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Evidence link (https://…)"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button type="submit" size="sm" busy={record.isPending} aria-label={`Record ${v.metric}`}>
            Record
          </Button>
          <OverflowMenu
            label={`More for ${v.metric}`}
            items={[
              { label: "Waive…", onSelect: () => setWaiving(true) },
              { label: "Remove", onSelect: () => remove.mutate(undefined), danger: true },
            ]}
          />
        </div>
      </form>
      <Dialog
        open={waiving}
        onClose={() => setWaiving(false)}
        title={`Waive ${v.metric}`}
        description="Waivers are recorded with your reason."
        footer={
          <>
            <Button onClick={() => setWaiving(false)}>Cancel</Button>
            <Button variant="primary" disabled={!reason.trim()} busy={waive.isPending} onClick={() => waive.mutate(undefined)}>
              Waive
            </Button>
          </>
        }
      >
        <Field id={`wv-${v.id}`} label="Reason">
          <textarea id={`wv-${v.id}`} data-autofocus className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </li>
  );
}

function Dependencies({ d, items, onSelect, open, onToggle }: { d: WorkDetail; items: WorkItem[]; onSelect: (id: string) => void } & SectionProps) {
  const [dest, setDest] = useState("");
  const add = useWorkMutation(() => api.post(`/api/work/items/${encodeURIComponent(d.item.id)}/dependencies`, { dependsOnId: dest }), {
    ok: "Dependency added",
    onSuccess: () => setDest(""),
  });
  const remove = useWorkMutation((depId: string) => api.del(`/api/work/dependencies/${encodeURIComponent(depId)}`), { ok: "Dependency removed" });
  const taken = new Set([d.item.id, ...d.blockedBy.map((b) => b.id)]);
  const options = itemPaths(
    items.filter((i) => i.parentId !== null && !i.archived),
    taken,
  );
  const openBlockers = d.blockedBy.filter((b) => b.open).length;
  const row = (r: DependencyRef, label: string) => (
    <li key={r.dependencyId} className="flex flex-wrap items-center justify-between gap-2 py-1">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" className="tap min-w-0 text-left break-words text-accent underline" onClick={() => onSelect(r.id)}>
          {r.title}
        </button>
        <StatusBadge status={r.status} />
      </span>
      <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.dependencyId)} aria-label={`${label} ${r.title}: remove`}>
        Remove
      </Button>
    </li>
  );
  return (
    <Section
      title="Dependencies"
      meta={openBlockers ? `Blocked by ${openBlockers}` : d.blockedBy.length + d.blocking.length ? `${d.blockedBy.length + d.blocking.length} linked` : "None"}
      phone
      open={open}
      onToggle={onToggle}
    >
      <h4 className="text-xs font-medium tracking-wide text-muted uppercase">Blocked by</h4>
      {d.blockedBy.length ? (
        <ul className="divide-y divide-line">{d.blockedBy.map((r) => row(r, "Blocked by"))}</ul>
      ) : (
        <p className="text-[13px] text-muted">Nothing. Add work this has to wait for.</p>
      )}
      {d.blocking.length ? (
        <>
          <h4 className="mt-3 text-xs font-medium tracking-wide text-muted uppercase">Blocks</h4>
          <ul className="divide-y divide-line">{d.blocking.map((r) => row(r, "Blocks"))}</ul>
        </>
      ) : null}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dest) add.mutate(undefined);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field id="dep-add" label="Depends on">
            <select id="dep-add" className={inputCls} value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button type="submit" size="sm" disabled={!dest} busy={add.isPending}>
          Add dependency
        </Button>
      </form>
    </Section>
  );
}

function linkLabel(l: WorkLink) {
  return l.kind === "chat_session" ? "Conversation" : l.kind === "github_pr" ? "Pull request" : l.kind === "github_issue" ? "Issue" : "Link";
}

function Links({ d, canChat, open, onToggle }: { d: WorkDetail; canChat: boolean } & SectionProps) {
  const hasChat = d.links.some((l) => l.kind === "chat_session");
  const convs = useConversations(canChat && hasChat);
  const activity = new Map((convs.data?.conversations ?? []).map((c) => [c.id, c.lastActiveAt]));
  const prs = d.links.filter((l) => l.kind === "github_pr" || l.kind === "github_issue").length;
  const chats = d.links.filter((l) => l.kind === "chat_session").length;
  const meta = d.links.length
    ? [
        prs ? `${prs} PR${prs === 1 ? "" : "s"}` : "",
        chats ? `${chats} chat${chats === 1 ? "" : "s"}` : "",
        d.links.length - prs - chats ? `${d.links.length - prs - chats} other` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "None";
  return (
    <Section title="Links" meta={meta} phone open={open} onToggle={onToggle} testId="work-links">
      {d.links.length ? (
        <ul className="wk-rows">
          {d.links.map((l) => (
            <LinkRow key={l.id} l={l} refresh={d.githubRefresh} lastActive={l.kind === "chat_session" ? activity.get(l.targetId ?? "") : undefined} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">Link the source conversation, the implementing PR, or evidence (⋯ menu above).</p>
      )}
      {!d.githubRefresh && d.links.some((l) => l.kind === "github_pr" || l.kind === "github_issue") ? (
        <p className="mt-1.5 text-xs text-muted">
          Add a GitHub token (Settings → Connections → GitHub) to refresh PR state from GitHub (read-only). Until then, mark it yourself.
        </p>
      ) : d.githubRefresh && d.links.some((l) => l.kind === "github_pr" || l.kind === "github_issue") ? (
        <p className="mt-1.5 text-xs text-muted">States refresh from GitHub (read-only), at most every 5 minutes per link.</p>
      ) : null}
    </Section>
  );
}

function LinkRow({ l, refresh, lastActive }: { l: WorkLink; refresh: boolean; lastActive?: string | null }) {
  const url = `/api/work/links/${encodeURIComponent(l.id)}`;
  const state = useWorkMutation((externalState: "open" | "merged" | "closed") => api.patch(url, { externalState }), {
    ok: l.kind === "github_issue" ? "Issue state updated" : "PR state updated",
  });
  const remove = useWorkMutation(() => api.del(url), { ok: "Link removed" });
  const pull = useWorkMutation(() => api.post(`${url}/refresh`), { ok: "Refreshed from GitHub" });
  const name = l.title || l.targetId || l.url || "";
  const smart = useSmartSettings();
  const [reviewing, setReviewing] = useState(false);
  return (
    <li className="py-2 first:pt-0.5 last:pb-0.5">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-xs text-muted">
            {linkLabel(l)} · {l.role}
            {l.lineage === "handoff_from" ? " · started from the handoff" : ""}
          </p>
          <p className="text-[13.5px] font-medium break-words">{name}</p>
          {(l.kind === "github_pr" || l.kind === "github_issue") && l.checkedAt ? (
            <p className={`text-xs ${l.checkError ? "text-danger" : "text-muted"}`}>
              {l.checkError ? `GitHub check failed ${fmtWhen(l.checkedAt)}: ${l.checkError}` : `Checked on GitHub ${fmtWhen(l.checkedAt)}`}
            </p>
          ) : null}
          {l.kind === "chat_session" ? <p className="text-xs text-muted">Last activity {lastActive ? fmtWhen(lastActive) : "unknown"}</p> : null}
        </div>
        <span className="flex flex-wrap items-center gap-1">
          {l.externalState ? (
            <Badge tone={l.externalState === "merged" ? "ok" : l.externalState === "closed" ? "neutral" : "accent"}>{l.externalState}</Badge>
          ) : null}
          {l.kind === "github_pr" && l.checksState ? (
            <Badge tone={l.checksState === "success" ? "ok" : l.checksState === "failure" ? "danger" : "warn"}>
              <span data-testid="link-checks">
                {l.checksState === "success" ? "checks green" : l.checksState === "failure" ? "checks red" : "checks running"}
              </span>
            </Badge>
          ) : null}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {l.kind === "chat_session" ? (
          <Link href={`/chat/${encodeURIComponent(l.targetId ?? "")}`} className="tap inline-flex items-center px-1 text-[13px] text-accent hover:underline">
            Open conversation<span className="sr-only">: {name}</span>
          </Link>
        ) : l.url ? (
          <a href={l.url} target="_blank" rel="noreferrer noopener" className="tap inline-flex items-center px-1 text-[13px] text-accent hover:underline">
            Open<span className="sr-only">: {name} (opens in a new tab)</span>
          </a>
        ) : null}
        {l.kind === "github_pr" && l.targetId && smart.data?.enabled ? (
          <Button size="sm" variant="ghost" onClick={() => setReviewing(true)} aria-label={`Review card: ${name}`}>
            Review card
          </Button>
        ) : null}
        {l.kind === "github_pr" && l.externalState !== "merged" ? (
          <Button size="sm" variant="ghost" onClick={() => state.mutate("merged")} busy={state.isPending}>
            Mark merged
          </Button>
        ) : null}
        <OverflowMenu
          label={`More for ${name}`}
          items={[
            ...(l.kind === "github_pr" && l.externalState === "open" ? [{ label: "Mark closed", onSelect: () => state.mutate("closed") }] : []),
            ...(l.kind === "github_issue"
              ? [
                  {
                    label: l.externalState === "closed" ? "Mark open" : "Mark closed",
                    onSelect: () => state.mutate(l.externalState === "closed" ? "open" : "closed"),
                  },
                ]
              : []),
            ...((l.kind === "github_pr" || l.kind === "github_issue") && refresh
              ? [{ label: "Refresh from GitHub", onSelect: () => pull.mutate(undefined) }]
              : []),
            { label: "Remove link", onSelect: () => remove.mutate(undefined), danger: true },
          ]}
        />
      </div>
      {reviewing && l.targetId ? (
        <Dialog open onClose={() => setReviewing(false)} title="Pull request" size="lg">
          <WorkflowSurface kind="pr" prRef={`pr:${l.targetId}`} compact />
        </Dialog>
      ) : null}
    </li>
  );
}

function LinkDialog({ kind, onClose, item }: { kind: LinkKind; onClose: () => void; item: WorkItem }) {
  const [value, setValue] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState(kind === "github_pr" ? "implementation" : kind === "chat_session" ? "source" : "reference");
  const add = useWorkMutation(
    () =>
      api.post(`/api/work/items/${encodeURIComponent(item.id)}/links`, {
        kind,
        ...(kind === "chat_session" ? { targetId: value } : { url: value }),
        title: title || undefined,
        role,
      }),
    { ok: "Linked", onSuccess: onClose },
  );
  const heading = kind === "github_pr" ? "Link a pull request" : kind === "chat_session" ? "Link a conversation" : "Link a URL";
  const label = kind === "github_pr" ? "GitHub PR URL" : kind === "chat_session" ? "Conversation id or /chat link" : "URL";
  return (
    <Dialog
      open
      onClose={onClose}
      title={heading}
      description={kind === "github_pr" ? "Jarvis only reads PR state; it never writes to GitHub." : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="link-form" busy={add.isPending}>
            Add link
          </Button>
        </>
      }
    >
      <form
        id="link-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined);
        }}
      >
        <Field id="lk-value" label={label}>
          <input
            id="lk-value"
            data-autofocus
            required
            className={inputCls}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={kind === "github_pr" ? "https://github.com/owner/repo/pull/123" : kind === "chat_session" ? "/chat/…" : "https://…"}
          />
        </Field>
        <Field id="lk-title" label="Title (optional)">
          <input id="lk-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id="lk-role" label="Role">
          <select id="lk-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="source">Source</option>
            <option value="implementation">Implementation</option>
            <option value="evidence">Evidence</option>
            <option value="reference">Reference</option>
          </select>
        </Field>
      </form>
    </Dialog>
  );
}

function ForkDialog({
  open,
  onClose,
  item,
  chat,
  onCreated,
  onOp,
}: {
  open: boolean;
  onClose: () => void;
  item: WorkItem;
  chat?: WorkLink;
  onCreated: (id: string) => void;
  onOp: OnOp;
}) {
  const [title, setTitle] = useState(`${item.title} (fork)`);
  const fork = useWorkMutation(() => api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}/fork`, { title }), {
    onSuccess: (r) => {
      onClose();
      onCreated(r.item.id);
      onOp(r.op);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Fork ${item.title}`}
      description="Creates a sibling with the same summary, next action and source links."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={fork.isPending} onClick={() => fork.mutate(undefined)}>
            Fork
          </Button>
        </>
      }
    >
      <Field id="fk-title" label="Title">
        <input id="fk-title" data-autofocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {chat ? (
        <p className="mt-3 text-sm">
          This item has a linked conversation.{" "}
          <Link href={`/chat/${encodeURIComponent(chat.targetId ?? "")}`} className="text-accent underline">
            Open conversation to fork there
          </Link>
          . Jarvis doesn&apos;t fork it automatically.
        </p>
      ) : null}
    </Dialog>
  );
}

function SplitDialog({
  open,
  onClose,
  item,
  onCreated,
  onOp,
}: {
  open: boolean;
  onClose: () => void;
  item: WorkItem;
  onCreated: (id: string) => void;
  onOp: OnOp;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const split = useWorkMutation(
    () => api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}/split`, { title, summary }),
    {
      onSuccess: (r) => {
        onClose();
        onCreated(r.item.id);
        onOp(r.op);
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Split from ${item.title}`}
      description="A new child item; the source stays as it is."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="split-form" busy={split.isPending}>
            Split
          </Button>
        </>
      }
    >
      <form
        id="split-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          split.mutate(undefined);
        }}
      >
        <Field id="sp-title" label="Child title">
          <input id="sp-title" data-autofocus required className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id="sp-summary" label="Summary excerpt">
          <textarea id="sp-summary" className={textareaCls} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

function PacketDialog({ open, onClose, d }: { open: boolean; onClose: () => void; d: WorkDetail }) {
  const prev = d.packets[0];
  const init = () => ({
    objective: prev?.objective ?? d.item.summary,
    inScope: prev?.inScope ?? "",
    outOfScope: prev?.outOfScope ?? "",
    acceptanceCriteria: prev?.acceptanceCriteria ?? "",
    decisions: prev?.decisions ?? "",
    openQuestions: prev?.openQuestions ?? "",
    context: prev?.context ?? "",
    nextAction: d.item.nextAction,
    status: (d.item.status === "ready" ? "ready" : "in_progress") as "ready" | "in_progress",
    // First packet: the area's default; revisions keep what the previous packet said.
    validationRequired: prev?.validationRequired ?? d.validationDefault.value === "required",
    noValidationReason:
      prev?.noValidationReason ?? (d.validationDefault.value === "optional" ? `Validation is optional in ${d.validationDefault.areaTitle ?? "this area"}` : ""),
  });
  const [f, setF] = useState(init);
  const save = useWorkMutation(
    () =>
      api.post(`/api/work/items/${encodeURIComponent(d.item.id)}/packets`, {
        ...f,
        noValidationReason: f.validationRequired ? undefined : f.noValidationReason,
      }),
    { ok: prev ? `Packet v${prev.version + 1} saved` : "Focused work started", onSuccess: onClose },
  );
  const area = (key: keyof typeof f, label: string) => (
    <Field id={`pk-${key}`} label={label}>
      <textarea id={`pk-${key}`} className={`${inputCls} min-h-16`} value={f[key] as string} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </Field>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={prev ? `Revise work packet (v${prev.version + 1})` : "Start focused work"}
      description="A work packet is an immutable handoff snapshot. Ready and in-progress work needs a next action."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="packet-form" busy={save.isPending}>
            Save packet
          </Button>
        </>
      }
    >
      <form
        id="packet-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field id="pk-objective" label="Objective">
          <textarea
            id="pk-objective"
            data-autofocus
            required
            className={`${inputCls} min-h-16`}
            value={f.objective}
            onChange={(e) => setF({ ...f, objective: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {area("inScope", "In scope")}
          {area("outOfScope", "Out of scope")}
        </div>
        {area("acceptanceCriteria", "Acceptance criteria")}
        <div className="grid gap-3 sm:grid-cols-2">
          {area("decisions", "Decisions")}
          {area("openQuestions", "Open questions")}
        </div>
        {area("context", "Context")}
        <Field id="pk-next" label="Next action">
          <input id="pk-next" required className={inputCls} value={f.nextAction} onChange={(e) => setF({ ...f, nextAction: e.target.value })} />
        </Field>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Move to</legend>
          {(["in_progress", "ready"] as const).map((s) => (
            <label key={s} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" name="pk-status" checked={f.status === s} onChange={() => setF({ ...f, status: s })} />
              {STATUS_LABELS[s]}
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={f.validationRequired} onChange={(e) => setF({ ...f, validationRequired: e.target.checked })} />
          Validation required before settling
        </label>
        <p className="-mt-2 text-xs text-muted">
          Default in {d.validationDefault.areaTitle ?? "this area"}: {d.validationDefault.value}
          {d.validationDefault.explicit ? " (set on the area)" : ""}.
        </p>
        {!f.validationRequired ? (
          <Field id="pk-novalidation" label="Why no validation is needed">
            <input
              id="pk-novalidation"
              required
              className={inputCls}
              value={f.noValidationReason}
              onChange={(e) => setF({ ...f, noValidationReason: e.target.value })}
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}

function SettleDialog({ open, onClose, d }: { open: boolean; onClose: () => void; d: WorkDetail }) {
  const [reason, setReason] = useState("");
  const settle = useWorkMutation(() => api.post(`/api/work/items/${encodeURIComponent(d.item.id)}/settle`, { reason }), { ok: "Settled", onSuccess: onClose });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Settle ${d.item.title}`}
      description={d.settle.allowed ? "Record the outcome. You can reopen any time." : d.settle.reason}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!d.settle.allowed} busy={settle.isPending} onClick={() => settle.mutate(undefined)}>
            Settle
          </Button>
        </>
      }
    >
      <Field id="st-reason" label="Outcome (optional)">
        <textarea id="st-reason" data-autofocus className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function ReopenDialog({ open, onClose, item, onFollowUp }: { open: boolean; onClose: () => void; item: WorkItem; onFollowUp: (id: string) => void }) {
  const [reason, setReason] = useState("");
  const [followUp, setFollowUp] = useState("");
  const reopen = useWorkMutation(
    () =>
      api.post<{ item: WorkItem; followUp: WorkItem | null }>(`/api/work/items/${encodeURIComponent(item.id)}/reopen`, {
        reason,
        followUpTitle: followUp || undefined,
      }),
    {
      ok: "Reopened",
      onSuccess: (r) => {
        onClose();
        if (r.followUp) onFollowUp(r.followUp.id);
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reopen ${item.title}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!reason.trim()} busy={reopen.isPending} onClick={() => reopen.mutate(undefined)}>
            Reopen
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field id="ro-reason" label="Why is it reopening?">
          <textarea id="ro-reason" data-autofocus className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field id="ro-follow" label="Follow-up child (optional)" hint="Creates a linked child item for the next round of work.">
          <input id="ro-follow" className={inputCls} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

const RELATION: Record<string, string> = { forked_from: "Forked from", split_from: "Split from", moved_from: "Moved from", handoff_from: "Follow-up of" };

function Activity({ d, onSelect }: { d: WorkDetail; onSelect: (id: string) => void }) {
  const { item } = d;
  return (
    <>
      <Card>
        <h3 className="mb-2 font-semibold">Lineage</h3>
        {d.links.some((l) => l.lineage === "handoff_from") ? (
          <ul className="mb-2 space-y-1 text-sm">
            {d.links
              .filter((l) => l.lineage === "handoff_from")
              .map((l) => {
                const p = d.packets.find((x) => x.id === l.packetId);
                return (
                  <li key={l.id}>
                    Handed off to{" "}
                    <Link href={`/chat/${encodeURIComponent(l.targetId ?? "")}`} className="tap text-accent underline">
                      {l.title}
                    </Link>{" "}
                    <span className="text-muted">
                      · {p ? `packet v${p.version}` : "no packet"} · {fmtDate(l.createdAt)}
                    </span>
                  </li>
                );
              })}
          </ul>
        ) : null}
        {d.lineage.length ? (
          <ul className="space-y-1 text-sm">
            {d.lineage.map((l) => {
              const mine = l.childId === item.id;
              const otherId = mine ? l.parentId : l.childId;
              const otherTitle = mine ? l.parentTitle : l.childTitle;
              const text = mine ? RELATION[l.relation] : l.relation === "moved_from" ? null : `${RELATION[l.relation]?.replace(/ (from|of)$/, "")} into`;
              if (!text) return null;
              return (
                <li key={l.id}>
                  {text}{" "}
                  {otherId && otherTitle ? (
                    <button type="button" className="tap text-accent underline" onClick={() => onSelect(otherId)}>
                      {otherTitle}
                    </button>
                  ) : (
                    <span className="text-muted">(top level)</span>
                  )}{" "}
                  <span className="text-muted">· {fmtDate(l.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        ) : d.links.some((l) => l.lineage === "handoff_from") ? null : (
          <p className="text-sm text-muted">No forks, splits or moves.</p>
        )}
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">Activity</h3>
        <ol className="space-y-2 text-sm">
          {d.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-2">
              <time dateTime={e.at} className="text-muted">
                {new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </time>
              <span className="break-words">
                {e.kind === "status" && e.toStatus
                  ? `${e.fromStatus ? STATUS_LABELS[e.fromStatus as WorkStatus] : "—"} → ${STATUS_LABELS[e.toStatus as WorkStatus]}${e.reason ? `: ${e.reason}` : ""}`
                  : e.kind === "created"
                    ? `Created${e.reason ? `: ${e.reason}` : ""}`
                    : (e.reason ?? e.kind)}
              </span>
              {e.source === "github" ? <Badge>GitHub</Badge> : null}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
