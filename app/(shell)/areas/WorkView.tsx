"use client";

import {
  AnchoredMenu,
  Button as KButton,
  ButtonLink as KButtonLink,
  ChipButton,
  Dialog,
  ErrorNote,
  Field,
  Input,
  LoadingState,
  MenuButton,
  Pill,
  RefPill,
  Select,
  StateWord,
  Textarea,
  useAnchoredMenu,
  useNow,
  useToast,
  type KMenuItem,
} from "@/components/ui";
import { Badge, Button, Card, Empty, Spinner, inputCls } from "@/components/ui/legacy";
import { useAgentRuns } from "@/components/agents/AgentRuns";
import { EscalationBanner } from "@/components/work/EscalationBanner";
import { CaptureTriageCard } from "@/components/capture/CaptureTriageCard";
import { itemAgentChip } from "@/components/work/AgentChip";
import { ItemWorkList, useItemWork, workRowId } from "@/components/work/ItemWork";
import { ItemRows, RollupGroups } from "@/components/work/Rollup";
import "@/components/work/item-page.css";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore, type ButtonHTMLAttributes, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { daysBetween } from "@/lib/time";
import { useAccess } from "@/components/access";
import { Markdown } from "@/components/markdown/Markdown";
import { WorkTree } from "@/components/work/WorkTree";
import { CheckIcon, ChevronIcon, PlusIcon } from "@/components/icons";
import { AreasNav, Block, StatusBadge, fmtDate, useGithubAutoRefresh, useWorkMutation } from "@/components/work/common";
import { AreaSettingsDialog } from "@/components/areas/AreaSettings";
import { NodeAgentChip, useNodeAgent } from "@/components/agents/NodeAgentChip";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { AreaCoordinator, AreaProjects } from "@/components/map/AreaPage";
import { ContinueDialog } from "@/components/work/ContinueDialog";
import { AdoptDialog } from "@/components/work/AdoptDialog";
import { WorkflowSurface } from "@/components/smart/WorkflowSurface";
import { useSmartSettings } from "@/components/smart/AssistantText";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { ActivityFeed } from "@/components/work/ActivityFeed";
import { INLINE_OP_EVENT, InlineText, useInlinePatch } from "@/components/work/InlineEdit";
import { DuePicker, SelectPicker, StatusPickerDot } from "@/components/work/MetaPicker";
import { filterItems, ItemFilterBar, ItemMetaEditor, NO_FILTER, type ItemFilter } from "@/components/work/ItemMeta";
import { inlineStatusOptions } from "@/lib/inline-edit";
import { ConversationLinkDialog, fmtWhen, itemPaths, useConversations } from "@/components/work/conversations";
import { InlineAdd, QuickAddDialog } from "@/components/work/QuickAdd";
import { NEW_WORK_EVENT } from "@/components/navigation/commands";
import { useShowArchived } from "@/lib/client/show-archived";
import { AreasOverview, MoveToDialog, NewMenu } from "@/components/work/structure";
import { useInbox } from "@/components/work/today";
import { MapView } from "@/components/map/MapView";
import "@/components/map/map.css";
import { AREA_PANEL_ID, AreaTabs } from "@/components/areas/AreaTabs";
import { BoardTab } from "@/components/areas/BoardTab";
import { GraphTab } from "@/components/areas/GraphTab";
import { PortfolioTab } from "@/components/areas/PortfolioTab";
import { areasHref, parseTab, type AreaTab } from "@/lib/areas-view";
import { CaptureDialog } from "@/components/work/inbox";
import { ActionSheet, useAiMenuItems, useSummaryMenuItem } from "@/components/work/ai/AiActions";
import { deployOf } from "@/lib/agent-runs";
import { agentChipLabel } from "@/lib/agents";
import type { AiActionKind } from "@/lib/ai";
import type { DecisionsResponse } from "@/lib/decisions";
import { selectEscalation } from "@/lib/item-escalation";
import {
  containerRollup,
  coordHref,
  itemNow,
  linkKind,
  logLine,
  type ContainerRollup,
  type ItemNow,
  type ItemWorkRow,
  type RollupItemRow,
} from "@/lib/item-page";
import {
  areaValidationDefault,
  COMPARATORS,
  isClosed,
  isContainer,
  KIND_LABELS,
  handoffMarkdown,
  itemPrimary,
  todayIso,
  STATUS_LABELS,
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
type ItemSection = "overview" | "chats" | "activity";
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
  initialTab = "overview",
}: {
  initialItem?: string;
  initialView?: WorkViewKind;
  /** Areas v2 view tab (`?tab=`): kept while the selection changes, and vice versa */
  initialTab?: AreaTab;
  initialAction?: string;
  /** the share target's text: opens the capture sheet prefilled */
  initialCapture?: string;
}) {
  const router = useRouter();
  const { can } = useAccess();
  const { toast } = useToast();
  const canChat = can("hermes.chat");
  const newChat = useAskHermes();
  const [archived, setArchived] = useShowArchived();
  const items = useItems(archived);
  const [view, setView] = useState<View>(initialItem ? { kind: "item", id: initialItem, action: initialAction } : { kind: initialView ?? "today" });
  const [tab, setTabState] = useState<AreaTab>(initialTab);
  // A tab swaps the pane in place: the selection (?item=) and the scroll position stay put.
  const setTab = (t: AreaTab) => {
    setTabState(t);
    // A palette action (?do=) runs once: a tab switch that remounts ItemDetail must not replay it.
    setView((v) => (v.kind === "item" && v.action ? { kind: "item", id: v.id } : v));
    window.history.replaceState(window.history.state, "", areasHref(window.location.href, { tab: t }));
  };
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
  // Inline edits in rows (Today) report their op here, so there is only ever one Undo bar.
  useEffect(() => {
    const on = (e: Event) => onOp((e as CustomEvent<UndoOp>).detail);
    window.addEventListener(INLINE_OP_EVENT, on);
    return () => window.removeEventListener(INLINE_OP_EVENT, on);
  }, [onOp]);
  const place = useWorkMutation(
    (v: { id: string; parentId: string | null; index: number }) =>
      api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(v.id)}/place`, { parentId: v.parentId, index: v.index }),
    { onSuccess: (r) => onOp(r.op) },
  );
  const rename = useWorkMutation(
    (v: { id: string; title: string }) => api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(v.id)}`, { title: v.title }),
    {
      // The "Saved · Undo" bar confirms it (one toast).
      onSuccess: (r) => onOp(r.op),
    },
  );
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

  const go = (next: View, opts?: { push?: boolean; tab?: AreaTab }) => {
    setView(next);
    if (opts?.tab) setTabState(opts.tab);
    const url = new URL(window.location.href);
    const keepTab = url.searchParams.get("tab");
    for (const k of ["item", "view", "do", "tab"]) url.searchParams.delete(k);
    if (next.kind === "item") url.searchParams.set("item", next.id);
    else if (next.kind !== "today") url.searchParams.set("view", next.kind);
    // The tab survives a selection change (re-centre the Graph, pick a tree row) unless the caller switches it.
    const nextTab = next.kind === "tree" || next.kind === "inbox" ? null : (opts?.tab ?? keepTab);
    if (nextTab && nextTab !== "overview") url.searchParams.set("tab", nextTab);
    // Opening an area from the overview pushes, so Back returns to the overview.
    if (opts?.push) window.history.pushState({ jarvisAreas: true }, "", url);
    else window.history.replaceState(null, "", url);
    // Phones: the content sits above the tree, so bring it into view.
    if (next.kind !== "tree" && window.matchMedia?.("(max-width: 1023px)").matches) document.getElementById("work-content")?.scrollIntoView({ block: "start" });
  };
  const openConversation = (sessionId: string) => router.push(`/chat/${encodeURIComponent(sessionId)}`);
  const select = (id: string) => {
    const it = items.data?.items.find((i) => i.id === id);
    if (it?.kind === "conversation" && it.sessionId && canChat) openConversation(it.sessionId);
    else go({ kind: "item", id });
  };
  /** Board rows and the Graph's "Open": the node's own page (Overview tab); Back returns to the view. */
  const openOverview = (id: string) => {
    const it = items.data?.items.find((i) => i.id === id);
    if (it?.kind === "conversation" && it.sessionId && canChat) openConversation(it.sessionId);
    else go({ kind: "item", id }, { push: true, tab: "overview" });
  };

  // Back/Forward after opening an area from the overview: follow the URL.
  useEffect(() => {
    const onPop = () => {
      const u = new URL(window.location.href);
      const id = u.searchParams.get("item");
      const v = u.searchParams.get("view");
      setView(id ? { kind: "item", id } : v === "tree" ? { kind: "tree" } : { kind: "today" });
      setTabState(parseTab(u.searchParams.get("tab")));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const list = items.data?.items ?? [];
  const current = view.kind === "item" && list.some((i) => i.id === view.id) ? view.id : null;
  const inboxCount = inbox.data?.count;
  // Areas v2 (B): the side tree carries status context (needs-you / in-flight counts, agent dots; next actions
  // only where the tree sits beside the page, ≥1024 — on phones it is a full-screen list and stays one line per row).
  const phoneTree = usePhone();
  const agentRuns = useAgentRuns().data;
  const treeStatus = useMemo(
    () => ({ showNext: !phoneTree, runs: Object.fromEntries(Object.entries(agentRuns?.items ?? {}).map(([id, r]) => [id, r.live])) }),
    [agentRuns, phoneTree],
  );
  // "+ New" creates where you are: inside the open area/project, or next to the open item.
  const open = current ? list.find((i) => i.id === current) : undefined;
  const contextNode = open ? (isContainer(open) ? open : (list.find((i) => i.id === open.parentId) ?? null)) : null;
  // Work items (leaves) fold their Chats section into the view tabs; areas/projects have no Chats tab.
  const leaf = !!open && !isContainer(open);
  const shownTab: AreaTab = (tab === "chats" && !leaf) || (tab === "portfolio" && current) ? "overview" : tab;

  // Header bar "New" → Item/Project/Area, created in the open container like the in-page menu.
  useEffect(() => {
    const onNew = (e: Event) => {
      const kind = (e as CustomEvent<{ kind?: CreatableKind }>).detail?.kind;
      if (kind) setAdding({ kind, parent: kind === "area" ? null : contextNode });
    };
    window.addEventListener(NEW_WORK_EVENT, onNew);
    return () => window.removeEventListener(NEW_WORK_EVENT, onNew);
  }, [contextNode]);

  return (
    <div className="wk-hub flex min-w-0 flex-col lg:grid lg:grid-rows-[auto_1fr]">
      <div className="wk-hub-top min-w-0 px-3 pt-3 pb-2 lg:col-start-1 lg:row-start-1 lg:px-2.5 lg:pb-1">
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
          <h1 className="wk-hub-title text-lg leading-tight font-semibold tracking-tight lg:text-[15px]">Areas</h1>
          {/* Desktop: the sidebar owns the tree, so bulk select is a page mode (multi-select list in the page body). */}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto hidden lg:inline-flex"
            aria-pressed={selectMode}
            onClick={() => {
              setSelectMode((m) => !m);
              setSelection(new Set());
            }}
            title="Select several rows to move or archive them together"
          >
            {selectMode ? "Done selecting" : "Select"}
          </Button>
          {/* >=1024 the header bar's New menu is the one "+ New" (it dispatches NEW_WORK_EVENT here). */}
          <div className="lg:hidden">
            <NewMenu
              canChat={canChat}
              busy={newChat.busy}
              context={contextNode}
              onChat={() => newChat.start(contextNode ? { areaId: contextNode.id } : undefined)}
              onNew={(kind) => setAdding({ kind, parent: kind === "area" ? null : contextNode })}
              onCapture={() => setCapturing(true)}
            />
          </div>
        </header>
        <AreasNav
          current={view.kind === "item" ? "tree" : view.kind}
          inboxCount={inboxCount}
          onPick={(k) => go({ kind: k }, { tab: "overview" })}
          className="px-1"
        />
      </div>
      <div id="work-content" className="order-2 min-w-0 scroll-mt-4 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1">
        {selectMode ? (
          <section aria-label="Select items" className="wk-select-page hidden min-w-0 px-3 py-3 sm:px-5 lg:block lg:px-6 lg:py-5">
            <SelectList
              items={list}
              selection={selection}
              onToggle={(id) =>
                setSelection((s) => {
                  const n = new Set(s);
                  if (n.has(id)) n.delete(id);
                  else n.add(id);
                  return n;
                })
              }
            />
            {selection.size ? (
              <div className="wk-bulk mt-2 lg:max-w-2xl" role="region" aria-label="Selection">
                <span className="mr-auto">{selection.size} selected</span>
                <Button size="sm" onClick={() => setMoving([...selection])}>
                  Move to…
                </Button>
                <Button size="sm" busy={bulkArchive.isPending} onClick={() => bulkArchive.mutate([...selection])}>
                  Archive
                </Button>
                <Button size="sm" variant="ghost" className="wk-bulk-clear" onClick={() => setSelection(new Set())}>
                  Clear
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
        <div className={selectMode ? "lg:hidden" : undefined}>
          {view.kind === "today" || current ? (
            // Areas v2: one tab bar in a fixed spot; a tab swaps only the pane below it and keeps the selection.
            <div className="min-w-0">
              <AreaTabs tab={shownTab} item={current} leaf={leaf} onTab={setTab} className="mx-3 mt-2 sm:mx-5 lg:mx-6 lg:mt-3" />
              <div id={AREA_PANEL_ID} role="tabpanel" aria-labelledby={`areas-tab-${shownTab}`} className="ar-panel min-w-0">
                {current && (shownTab === "board" || shownTab === "graph" || (shownTab === "activity" && !leaf)) ? (
                  <NodeHeader id={current} items={list} onSelect={select} />
                ) : null}
                {current && leaf && (shownTab === "overview" || shownTab === "chats" || shownTab === "activity") ? (
                  // A work item keeps its own page (header, actions); the view tab picks its section.
                  <ItemDetail
                    key={current}
                    id={current}
                    items={list}
                    onSelect={select}
                    onOp={onOp}
                    initialAction={view.kind === "item" ? view.action : undefined}
                    onAdd={(kind, parent) => setAdding({ kind, parent })}
                    onMove={(ids) => setMoving(ids)}
                    section={shownTab}
                    onSection={setTab}
                  />
                ) : shownTab === "board" ? (
                  <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-4">
                    <BoardTab scopeId={current} selectedId={current} onOpen={openOverview} />
                  </div>
                ) : shownTab === "activity" ? (
                  <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-4">
                    {current ? (
                      <ActivityFeed key={current} scope={{ item: current, descendants: true }} onSelect={select} label="Activity" />
                    ) : (
                      <ActivityFeed
                        areas={list.filter((i) => i.parentId === null && !i.archived).map((i) => ({ id: i.id, title: i.title }))}
                        onSelect={select}
                        label="All activity"
                      />
                    )}
                  </div>
                ) : shownTab === "portfolio" ? (
                  <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
                    <PortfolioTab onOpen={(id) => go({ kind: "item", id }, { push: true })} />
                  </div>
                ) : shownTab === "graph" ? (
                  <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-4">
                    <GraphTab items={list} centreId={current} onRecentre={(id) => (id ? select(id) : go({ kind: "today" }))} onOpen={openOverview} />
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
                ) : (
                  // "Map is Areas": the landing is the portfolio overview; a card opens its area here, in place.
                  <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
                    <MapView onOpen={(id) => go({ kind: "item", id }, { push: true })} />
                  </div>
                )}
              </div>
            </div>
          ) : view.kind === "tree" ? (
            <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
              <AreasOverview items={list} onSelect={select} onNewArea={() => setAdding({ kind: "area", parent: null })} />
            </div>
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
            <LoadingState label="Loading work…" />
          ) : (
            <WorkTree
              items={list}
              linked={items.data?.linkedConversations}
              status={treeStatus}
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

const RAIL_RELATION: Record<string, string> = {
  forked_from: "↖ Forked from",
  split_from: "↖ Split from",
  moved_from: "↖ Moved from",
  handoff_from: "↖ Follow-up of",
};
const CMP_TEXT: Record<string, string> = { "<=": "≤", ">=": "≥", "<": "<", ">": ">", "=": "=" };

/**
 * The item's context rail (wide screens, design Direction C): only what the page's one column does not already
 * say. Where it sits (area, repo, settle policy), when it is planned and closed, and its lineage. Status, due,
 * pull requests, blockers and conversations are on the page itself (header, Plan), so they are not repeated here.
 */
function ItemRail({ d, onSelect }: { d: WorkDetail; onSelect: (id: string) => void }) {
  const { item } = d;
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
  return (
    <aside aria-label="Item context" className="wk-rail flex min-w-0 flex-col gap-3 p-3.5" data-testid="item-rail">
      <Block label="Properties">
        <dl className="wk-kv">
          {d.area ? (
            <>
              <dt>Area</dt>
              <dd className="truncate">{d.area.title}</dd>
            </>
          ) : null}
          {d.area?.settings.defaultRepo ? (
            <>
              <dt>Repo</dt>
              <dd className="truncate font-mono text-xs">{d.area.settings.defaultRepo}</dd>
            </>
          ) : null}
          {d.area ? (
            <>
              <dt>Settle</dt>
              <dd>{SETTLE_TEXT[d.area.settings.settlePolicy] ?? d.area.settings.settlePolicy}</dd>
            </>
          ) : null}
          <dt>Planned</dt>
          <dd>
            {item.startDate || item.targetDate
              ? `${item.startDate ? shortDate(item.startDate) : "—"} → ${item.targetDate ? shortDate(item.targetDate) : "—"}`
              : "Not planned"}
          </dd>
          {item.completedAt ? (
            <>
              <dt>Closed</dt>
              <dd>{shortDate(item.completedAt)}</dd>
            </>
          ) : null}
        </dl>
      </Block>
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
    </aside>
  );
}

const SETTLE_TEXT: Record<string, string> = { manual: "Manual", suggest: "Suggest when quiet", auto_after_quiet: "Auto when quiet" };

type ChatRow = { key: string; sessionId: string; title: string; note: string };

/** Chats tab rows: linked chat sessions plus conversations filed under the item (deduped by session). */
function itemChatRows(d: { links: WorkLink[]; children: WorkItem[] }): ChatRow[] {
  const rows: ChatRow[] = [];
  const seen = new Set<string>();
  for (const l of d.links) {
    if (l.kind !== "chat_session" || !l.targetId || seen.has(l.targetId)) continue;
    seen.add(l.targetId);
    rows.push({ key: l.id, sessionId: l.targetId, title: l.title, note: l.role });
  }
  for (const c of d.children) {
    if (c.kind !== "conversation" || c.archived || !c.sessionId || seen.has(c.sessionId)) continue;
    seen.add(c.sessionId);
    rows.push({ key: c.id, sessionId: c.sessionId, title: c.title, note: "filed here" });
  }
  return rows;
}

/** Chats tab: conversations linked to or filed under this item. */
function ItemChats({ chats, canChat, onNew, busy }: { chats: ChatRow[]; canChat: boolean; onNew: () => void; busy: boolean }) {
  return (
    <section aria-label="Chats">
      {chats.length ? (
        <ul className="k-card wk-node-rows overflow-hidden">
          {chats.map((l) => (
            <li key={l.key}>
              <Link href={`/chat/${encodeURIComponent(l.sessionId)}`} className="wk-node-row" aria-label={`Chat: ${l.title || l.sessionId}`}>
                <span className="min-w-0 flex-1 truncate">{l.title || <span className="font-mono text-xs">{l.sessionId}</span>}</span>
                <span className="shrink-0 text-xs text-muted">{l.note}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No chats linked yet.</p>
      )}
      {canChat ? (
        <Button size="sm" className="mt-2" busy={busy} onClick={onNew}>
          New chat here
        </Button>
      ) : null}
    </section>
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

function shortDate(d: string) {
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

type DialogKind =
  | null
  | "adopt"
  | "fork"
  | "split"
  | "packet"
  | "settle"
  | "reopen"
  | "continue"
  | "blocker"
  | "validation"
  | "templates"
  | "dates"
  | "handoff"
  | CloseStatus
  | LinkKind;

/** Terminal statuses set from ⋯ with an optional reason (Settle keeps its own gated dialog). */
type CloseStatus = "abandoned" | "superseded";

type OnOp = (op: UndoOp | null | undefined) => void;

/** A dashed "add" chip: one per thing the page does not have yet (rule: empty sections are not drawn). */
function AddChip({
  label,
  name,
  ...rest
}: { label: string; name: string; ref?: Ref<HTMLButtonElement> } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <KButton variant="ghost" size="sm" className="ip-add" aria-label={name} icon={<PlusIcon className="h-3.5 w-3.5" />} {...rest}>
      {label}
    </KButton>
  );
}

/** An "add" chip for something that comes in kinds (a link: pull request, conversation, URL): it opens a menu. */
function AddMenuChip({ label, name, items }: { label: string; name: string; items: KMenuItem[] }) {
  const menu = useAnchoredMenu();
  const { open, close, openFromTrigger, setTrigger } = menu;
  return (
    <>
      <AddChip label={label} name={name} ref={setTrigger} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : openFromTrigger())} />
      <AnchoredMenu menu={menu} label={name} items={items} />
    </>
  );
}

/** Log: one line that opens the Activity view (the feed is drawn there, once). */
function LogLine({ d, onOpen }: { d: WorkDetail; onOpen: () => void }) {
  const now = useNow();
  return (
    <KButton variant="ghost" className="ip-log" onClick={onOpen} data-testid="item-log">
      <span className="ip-next-label">Log</span>
      <span className="ip-log-text">
        <span data-dynamic>{logLine(d.events, now) ?? "No changes yet"}</span>
        {itemAgentChip(d.item)}
      </span>
      <ChevronIcon className="ip-chev h-4 w-4" />
    </KButton>
  );
}

/**
 * A node's page. Work (threads, investigations, notes) reads top to bottom: what needs you (Now), what is next,
 * what is running (Work), what proves it is done (Done when), the plan, and one Log line. Containers (areas,
 * projects) get the same three groups rolled up from their items. Everything that is not on the page is in ⋯.
 */
function ItemDetail({
  id,
  items,
  onSelect,
  onOp,
  initialAction,
  onAdd,
  onMove,
  section,
  onSection,
}: {
  id: string;
  items: WorkItem[];
  onSelect: (id: string) => void;
  onOp: OnOp;
  /** from the command palette / Today: packet | continue | settle | validate */
  initialAction?: string;
  onAdd: (kind: CreatableKind | undefined, parent: WorkItem) => void;
  onMove: (ids: string[]) => void;
  /** Areas v2: the page's view tabs own the work item's sections (one tab bar, no inner tablist) */
  section?: ItemSection;
  onSection?: (s: ItemSection) => void;
}) {
  const router = useRouter();
  const q = useQuery({ queryKey: ["work", "item", id], queryFn: () => api.get<WorkDetail>(`/api/work/items/${encodeURIComponent(id)}`) });
  const [ownTab, setOwnTab] = useState<ItemSection>("overview");
  const tab = section ?? ownTab;
  const setTab = onSection ?? setOwnTab;
  const [dialog, setDialog] = useState<DialogKind>(
    initialAction === "packet" ? "packet" : initialAction === "continue" ? "continue" : initialAction === "settle" ? "settle" : null,
  );
  const patch = useWorkMutation((body: Record<string, unknown>) => api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(id)}`, body), {
    onSuccess: (r) => onOp(r.op),
    ok: "Saved",
  });
  // Inline field edits (title, next action, summary, status, due date): optimistic, one Undo bar.
  const inline = useInlinePatch(id, onOp);
  const reorder = useWorkMutation(
    (direction: "up" | "down") => api.post<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(id)}/reorder`, { direction }),
    { onSuccess: (r) => onOp(r.op) },
  );
  const close = () => setDialog(null);
  const [aiSheet, setAiSheet] = useState<AiActionKind | null>(
    initialAction?.startsWith("ai:") && ["research", "plan", "schedule", "draft", "summarize"].includes(initialAction.slice(3))
      ? (initialAction.slice(3) as AiActionKind)
      : null,
  );
  const aiItems = useAiMenuItems(id, setAiSheet);
  const summaryItem = useSummaryMenuItem(id, setAiSheet);
  const wide = useWide();
  const [renaming, setRenaming] = useState<string | null>(null);
  // An add chip opens the field's own inline editor: nothing is edited in two places.
  const [editing, setEditing] = useState<"summary" | "next" | null>(null);
  // A3: area settings and the archive confirmation open from the area header's ⋯.
  const [areaSheet, setAreaSheet] = useState<"settings" | "archive" | null>(null);
  // Conversations are Hermes/Claude chats: only offered to people who can chat (the API checks too).
  const canChat = useAccess().can("hermes.chat");
  const isOwner = useAccess().isAdmin;
  const newChat = useAskHermes();
  if (dialog === "continue" && !canChat) setDialog(null);
  useGithubAutoRefresh(!!q.data?.githubRefresh && q.data.links.some((l) => l.kind === "github_pr" || l.kind === "github_issue"), id);
  const menu = useAnchoredMenu();
  // Runs, jobs and reports on the item (and, for a project, under it): the Work list, the Now slot, the roll-up.
  const work = useItemWork(id, !!q.data);
  const asked = useQuery({
    queryKey: ["work", "decisions"],
    queryFn: () => api.get<DecisionsResponse>("/api/work/decisions"),
    enabled: !!q.data,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const nowMs = useNow();
  const nodeAgent = useNodeAgent(id, q.data?.item.updatedAt, !!q.data && canChat);
  // Work rows opened in place: held here so a "jump to it" chip in the Now slot can open one.
  const [workOpen, setWorkOpen] = useState<ReadonlySet<string>>(() => new Set());
  const copyHandoff = useCopyHandoff(q.data);

  if (q.isPending)
    return (
      <div className="p-6">
        <LoadingState label="Loading item…" />
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
  /** A piece of work with its own page: everything but containers and conversations. */
  const leaf = !container && item.kind !== "conversation";
  const chat = d.links.find((l) => l.kind === "chat_session");
  const scrollTo = (selector: string) => {
    setTab("overview");
    requestAnimationFrame(() => document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const toggleWork = (key: string) =>
    setWorkOpen((open) => {
      const next = new Set(open);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const jumpToWork = (key: string) => {
    setTab("overview");
    setWorkOpen((open) => new Set(open).add(key));
    requestAnimationFrame(() => document.getElementById(workRowId(key))?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };
  const action = itemPrimary(d, canChat);
  // Now: the escalation, else a pointer to what waits on the owner, else the one primary action for this state.
  const escalated = leaf && !!selectEscalation(item.id, asked.data?.entries ?? [], work.info, nowMs);
  const now: ItemNow = leaf
    ? itemNow({ itemId: item.id, escalation: escalated, action, rows: work.rows, decisions: work.decisions })
    : { kind: "action", action };
  const needsOwner = now.kind !== "action";
  /** The state action the page shows as its primary; null while something needs the owner (it is in ⋯ then). */
  const shown = container || now.kind !== "action" ? null : now.action;
  // Links come oldest first: prefer the newest open PR (implementation role first), else the newest PR.
  const prLinks = d.links.filter((l) => l.kind === "github_pr" && l.url).reverse();
  const openPr =
    prLinks.find((l) => l.externalState === "open" && l.role === "implementation") ??
    prLinks.find((l) => l.externalState === "open") ??
    prLinks.find((l) => l.externalState !== "merged" && l.externalState !== "closed") ??
    prLinks[0];
  const chats = itemChatRows(d);
  const reopenable = item.status === "settled" || item.status === "awaiting_validation" || d.validations.some((v) => v.status === "fail");
  const childLabel = isArea ? "Project" : "Item";
  const usedAsWork = d.packets.length > 0 || d.validations.length > 0;
  const hasBlockers = d.blockedBy.length + d.blocking.length > 0;
  const rollup = containerRollup({ item, items, agents: work.agents, runs: work.runs, decisions: work.decisions, now: nowMs });
  // Sub-items of a work item: the same rows as a project's items.
  const kids = container ? { items: [], done: [] } : rollup;
  const kidCount = kids.items.length + kids.done.length;

  // ⋯ holds everything that is not on the page, grouped. A group with nothing to offer is not drawn.
  const group = (label: string, entries: (KMenuItem | false | null | undefined)[]): KMenuItem[] => {
    const list = entries.filter((x): x is KMenuItem => !!x);
    return list.length ? [{ label, heading: true }, ...list] : [];
  };
  const answers = nodeAgent?.requested ? agentChipLabel(nodeAgent) : null;
  const menuItems: KMenuItem[] = [
    ...group(answers ? `Ask · ${answers.startsWith("@") ? answers : `@${answers}`} answers here` : "Ask", [
      leaf && canChat ? { label: "Chat here", onSelect: () => newChat.start({ areaId: item.id }) } : null,
      container && canChat ? { label: "New chat here", onSelect: () => newChat.start({ areaId: item.id }) } : null,
      isArea && canChat && isOwner ? { label: "Adopt existing chat…", onSelect: () => setDialog("adopt") } : null,
      ...aiItems,
      summaryItem,
    ]),
    ...group("Work", [
      // A project with no items yet can still be worked directly.
      (item.kind === "project" && !isArea) || (leaf && shown !== "packet")
        ? { label: d.packets.length ? "Revise work packet" : "Start focused work", onSelect: () => setDialog("packet") }
        : null,
      (leaf && shown !== "settle" && item.status !== "settled") || (container && usedAsWork && item.status !== "settled")
        ? { label: "Settle…", onSelect: () => setDialog("settle") }
        : null,
      !container && reopenable && shown !== "reopen" ? { label: "Reopen", onSelect: () => setDialog("reopen") } : null,
      // The packet block carries these once a packet exists.
      !container && !d.packets.length ? { label: "Copy handoff", onSelect: () => void copyHandoff() } : null,
      !container && !d.packets.length ? { label: "Preview handoff", onSelect: () => setDialog("handoff") } : null,
      !container && canChat && !d.packets.length ? { label: "Continue in new conversation", onSelect: () => setDialog("continue") } : null,
    ]),
    ...group("Add", [
      container || item.kind === "note" ? null : { label: "Add sub-item", onSelect: () => onAdd("thread", item) },
      // Areas: "+ Project" is the one primary add; a loose item goes through ⋯.
      isArea ? { label: "Add item to area", onSelect: () => onAdd("thread", item) } : null,
      isArea ? null : { label: "Link PR", onSelect: () => setDialog("github_pr") },
      isArea || !canChat ? null : { label: "Link conversation", onSelect: () => setDialog("chat_session") },
      isArea ? null : { label: "Link URL", onSelect: () => setDialog("url") },
      isArea ? null : { label: "Add blocker…", onSelect: () => setDialog("blocker") },
      !container || usedAsWork ? { label: "Add validation", onSelect: () => setDialog("validation") } : null,
      !container || usedAsWork ? { label: "Add from template", onSelect: () => setDialog("templates") } : null,
    ]),
    ...group("Organise", [
      { label: "Rename", hint: "F2", onSelect: () => setRenaming(item.title), disabled: item.builtIn },
      { label: "Move…", hint: "M", onSelect: () => onMove([item.id]), disabled: item.builtIn },
      { label: "Move up", onSelect: () => reorder.mutate("up") },
      { label: "Move down", onSelect: () => reorder.mutate("down") },
      { label: isArea ? "Area details…" : "Planned dates…", onSelect: () => setDialog("dates") },
      item.kind === "project" && !isArea
        ? { label: "Convert to item", onSelect: () => patch.mutate({ kind: "thread" }) }
        : !isArea && item.kind !== "conversation"
          ? { label: "Convert to project", onSelect: () => patch.mutate({ kind: "project" }) }
          : null,
      isArea ? null : { label: "Fork", onSelect: () => setDialog("fork") },
      container ? null : { label: "Split into child", onSelect: () => setDialog("split") },
      isArea && !item.builtIn ? { label: "Area settings…", onSelect: () => setAreaSheet("settings") } : null,
      isArea && isOwner ? { label: "Scheduled jobs", onSelect: () => router.push(`/settings/agents?area=${encodeURIComponent(item.id)}#schedules`) } : null,
    ]),
    ...group("Close", [
      isArea || isClosed(item.status) ? null : { label: "Abandon…", onSelect: () => setDialog("abandoned"), disabled: item.builtIn },
      isArea || isClosed(item.status) ? null : { label: "Mark superseded…", onSelect: () => setDialog("superseded"), disabled: item.builtIn },
      {
        label: item.archived ? "Unarchive" : isArea ? "Archive area…" : "Archive",
        // Archiving a whole area hides everything under it: confirm first.
        onSelect: () => (isArea && !item.archived ? setAreaSheet("archive") : patch.mutate({ archived: !item.archived })),
        disabled: item.builtIn,
        danger: !item.archived,
      },
    ]),
  ];

  const pending = d.validations.filter((v) => v.status === "pending").length;
  const openBlockers = d.blockedBy.filter((b) => b.open);
  // The page's ONE primary action, and (only where it says something the button does not) why it is next.
  const primary =
    shown === "open_chat" && item.sessionId ? (
      <KButtonLink href={`/chat/${encodeURIComponent(item.sessionId)}`} variant="primary" size="sm">
        Open conversation
      </KButtonLink>
    ) : shown === "settle" ? (
      <KButton size="sm" variant="primary" onClick={() => setDialog("settle")} disabled={!d.settle.allowed} title={d.settle.reason ?? undefined}>
        Settle…
      </KButton>
    ) : shown === "record" ? (
      <KButton size="sm" variant="primary" onClick={() => scrollTo("#work-validations")}>
        Record result
      </KButton>
    ) : shown === "reopen" ? (
      // Settled work: reopening is possible but not the expected next step, so it is not styled as the primary.
      <KButton size="sm" variant={item.status === "settled" ? "secondary" : "primary"} onClick={() => setDialog("reopen")}>
        Reopen
      </KButton>
    ) : shown === "continue" ? (
      <KButton size="sm" variant="primary" onClick={() => setDialog("continue")}>
        Continue in chat
      </KButton>
    ) : shown === "open_pr" && openPr?.url ? (
      <KButtonLink href={openPr.url} external variant="primary" size="sm">
        Open PR
      </KButtonLink>
    ) : shown === "resolve_blocker" ? (
      <KButton size="sm" variant="primary" onClick={() => scrollTo('[data-testid="work-deps"]')}>
        Resolve blocker
      </KButton>
    ) : shown === "packet" && leaf ? (
      <KButton
        size="sm"
        variant="primary"
        onClick={() => setDialog("packet")}
        title={d.packets.length ? "Start focused work (revise the work packet)" : undefined}
      >
        Start focused work
      </KButton>
    ) : null;
  const why =
    shown === "settle"
      ? d.settle.allowed
        ? item.status === "ready_to_settle"
          ? "Ready to settle: nothing left to validate."
          : "Every check is in."
        : d.settle.reason
      : shown === "record"
        ? `${pending} check${pending === 1 ? " still needs" : "s still need"} a result.`
        : shown === "resolve_blocker"
          ? `Blocked by ${openBlockers.length === 1 ? openBlockers[0]!.title : `${openBlockers.length} items`}.`
          : shown === "reopen"
            ? item.settledReason
            : null;

  // One status control: the pill is the select (dot + label + caret), not a pill plus a second dropdown.
  const statusSelect = isArea ? null : (
    <span className="ip-meta-status" data-status={item.status}>
      <SelectPicker
        id="work-status"
        label="Status"
        className="status-pill jv-select-status shrink-0"
        data-s={item.status}
        active={false}
        value={item.status}
        options={inlineStatusOptions(item.status).map((o) => ({ ...o, dot: <StatusPickerDot status={o.value} /> }))}
        onChange={(v) => {
          const to = v as WorkStatus;
          // Settling is never inline: it stays the Settle… dialog (primary action / ⋯).
          if (to === "reopened") setDialog("reopen");
          else inline.mutate({ status: to });
        }}
      />
      {item.settledKind === "auto" && item.status === "settled" ? <Badge tone="neutral">Auto-settled</Badge> : null}
      {container ? null : <DuePicker value={item.targetDate} onSave={(targetDate) => inline.mutate({ targetDate })} />}
    </span>
  );

  const adds = leaf
    ? [
        needsOwner && !item.nextAction && editing !== "next" ? (
          <AddChip key="next" label="Next step" name="Add the next step" onClick={() => setEditing("next")} />
        ) : null,
        !item.summary && !item.builtIn && editing !== "summary" ? (
          <AddChip key="summary" label="Summary" name="Add a summary" onClick={() => setEditing("summary")} />
        ) : null,
        !kidCount && item.kind !== "note" ? <AddChip key="sub" label="Sub-item" name="Add sub-item" onClick={() => onAdd("thread", item)} /> : null,
        !d.links.length ? (
          <AddMenuChip
            key="link"
            label="Link"
            name="Add a link"
            items={[
              { label: "Link PR", onSelect: () => setDialog("github_pr") },
              ...(canChat ? [{ label: "Link conversation", onSelect: () => setDialog("chat_session") }] : []),
              { label: "Link URL", onSelect: () => setDialog("url") },
            ]}
          />
        ) : null,
        !hasBlockers ? <AddChip key="blocker" label="Blocker" name="Add blocker" onClick={() => setDialog("blocker")} /> : null,
        !d.validations.length ? <AddChip key="validation" label="Validation" name="Add validation" onClick={() => setDialog("validation")} /> : null,
        !d.packets.length && shown !== "packet" ? <AddChip key="packet" label="Packet" name="Add work packet" onClick={() => setDialog("packet")} /> : null,
      ].filter(Boolean)
    : [
        // Containers: the summary and (areas) the next step are edited in place once they exist.
        !item.summary && !item.builtIn && editing !== "summary" ? (
          <AddChip key="summary" label="Summary" name="Add a summary" onClick={() => setEditing("summary")} />
        ) : null,
        isArea && !item.nextAction && editing !== "next" ? (
          <AddChip key="next" label="Next step" name="Add the next step" onClick={() => setEditing("next")} />
        ) : null,
      ].filter(Boolean);
  const summary =
    item.summary || editing === "summary" ? (
      <InlineText
        field="summary"
        multiline
        value={item.summary}
        disabled={item.builtIn}
        editButton
        editing={editing === "summary" ? true : undefined}
        onEditingChange={(on) => setEditing(on ? "summary" : null)}
        className="wk-summary-inline"
        placeholder="Add a summary"
        onSave={(text) => inline.mutate({ summary: text })}
      >
        {item.summary ? <Summary key={item.id} text={item.summary} /> : undefined}
      </InlineText>
    ) : null;
  // While something needs the owner, an unwritten next action is not drawn (its "add" chip offers it instead).
  const showNext = item.kind !== "conversation" && (!!item.nextAction || editing === "next" || (!isArea && !needsOwner));

  return (
    <article aria-labelledby="work-item-title" className="min-w-0" data-node-kind={container ? (isArea ? "area" : "project") : "work"}>
      <section className="bg-surface px-3 pt-3 pb-3 sm:px-5 lg:px-6 lg:pt-4">
        <nav aria-label="Breadcrumb" className="wk-crumbs">
          <ol className="flex flex-wrap items-center gap-0.5 text-xs text-muted">
            {d.breadcrumb.map((b) => (
              <li key={b.id} className="flex items-center gap-0.5">
                <button type="button" className="tap rounded px-1 hover:text-accent hover:underline" onClick={() => onSelect(b.id)}>
                  {b.title}
                </button>
                <span aria-hidden="true">›</span>
              </li>
            ))}
            <li aria-current="page" className="wk-kind inline-flex items-center gap-1 px-1">
              {isArea && item.settings?.color ? (
                <span className={`jv-pick-dot jv-tag-${item.settings.color}`} aria-hidden="true" data-testid="area-color" />
              ) : null}
              {isArea ? "Area" : item.kind === "thread" ? "Item" : KIND_LABEL[item.kind]}
            </li>
          </ol>
        </nav>
        {/* Header: the title, ONE menu, then ONE meta line (status, due, assignee and tags; a container's counts). */}
        <div className="ip-title-row">
          <h2 id="work-item-title" className="min-w-0 text-lg leading-snug font-semibold tracking-tight break-words lg:text-[21px]">
            <InlineText
              field="title"
              value={item.title}
              disabled={item.builtIn}
              editing={renaming !== null}
              onEditingChange={(on) => setRenaming(on ? item.title : null)}
              inputClassName="text-[16px] font-semibold lg:text-[19px]"
              onSave={(title) => inline.mutate({ title })}
            />
          </h2>
          <div className="ip-title-acts">
            {container ? (
              <KButton size="sm" variant="primary" onClick={() => onAdd(isArea ? "project" : "thread", item)}>
                + {childLabel}
              </KButton>
            ) : null}
            <MenuButton menu={menu} label="More item actions" />
            <AnchoredMenu menu={menu} label="More item actions" items={menuItems} />
          </div>
        </div>
        <div className="ip-meta">
          {statusSelect}
          {item.archived ? <Badge>Archived</Badge> : null}
          {leaf ? (
            <div className="ip-meta-in" data-testid="work-item-meta">
              <ItemMetaEditor tags={item.tags ?? []} assignee={item.assignee ?? null} disabled={item.archived} onSave={(change) => inline.mutate(change)} />
            </div>
          ) : null}
          {container ? (
            <span className="ip-meta-text wk-cmeta" data-dynamic>
              {rollup.meta}
            </span>
          ) : null}
          {/* The agent mode is set on areas and projects, so they say who answers here; an item says it in ⋯. */}
          {container && canChat ? <NodeAgentChip nodeId={item.id} version={item.updatedAt} /> : null}
        </div>
        {/* Next: ONE section. What needs you is the next step (the decision, or a chip that jumps to what waits on
            you), with the written next action under it as a quiet line. When nothing needs you: the next action,
            then the page's one primary action for this state. */}
        <div className="ip-nextsec" role="group" aria-labelledby="ip-next-h" data-testid="item-next" data-needs={needsOwner || undefined}>
          {needsOwner || !showNext ? (
            <h3 id="ip-next-h" className={needsOwner ? "ip-label ip-next-head" : "sr-only"}>
              Next
            </h3>
          ) : null}
          {leaf ? <EscalationBanner itemId={item.id} onAskAgain={canChat ? () => setDialog("continue") : undefined} /> : null}
          {leaf ? <CaptureTriageCard itemId={item.id} /> : null}
          {now.kind === "pointer" ? (
            <p className="ip-now-pointer" data-testid="now-pointer">
              <StateWord state={now.decisions.length ? "needs" : now.rows[0]!.state} />
              {now.decisions.map((x) => (
                <RefPill key={x.ref} id={x.ref} onClick={() => router.push(coordHref(item.id, "needs", x.ref))} />
              ))}
              {now.rows.map((row) =>
                row.kind === "run" && row.refId ? (
                  <RefPill key={row.key} id={row.refId} onClick={() => jumpToWork(row.key)} />
                ) : (
                  <ChipButton key={row.key} className="ip-jump" onClick={() => jumpToWork(row.key)}>
                    {row.title}
                  </ChipButton>
                ),
              )}
              {/* One thing waiting: say what it waits for, so the next step reads without opening anything. */}
              {now.decisions.length + now.rows.length === 1 ? <span className="ip-now-note">{now.decisions[0]?.question ?? now.rows[0]!.note}</span> : null}
            </p>
          ) : null}
          {showNext ? (
            <div className="ip-next" data-quiet={needsOwner || undefined} data-testid="next-action">
              {needsOwner ? (
                <span className="ip-next-label">Then</span>
              ) : (
                <h3 id="ip-next-h" className="ip-next-label">
                  Next
                </h3>
              )}
              <InlineText
                key={item.updatedAt}
                field="nextAction"
                value={item.nextAction}
                status={item.status}
                disabled={item.builtIn}
                editing={editing === "next" ? true : undefined}
                onEditingChange={(on) => setEditing(on ? "next" : null)}
                placeholder="Add the very next step"
                onSave={(nextAction) => inline.mutate({ nextAction })}
              />
            </div>
          ) : null}
          {primary ? (
            <div className="ip-now-act" data-testid={item.status === "ready_to_settle" ? "settle-prompt" : "item-primary"}>
              {why ? <p className="ip-now-why">{why}</p> : null}
              {primary}
            </div>
          ) : item.settledReason ? (
            <p className="ip-now-why mt-2">{item.settledReason}</p>
          ) : null}
        </div>
        {container ? (
          <>
            {summary}
            <div className="ip-adds" role="group" aria-label={`Add to this ${isArea ? "area" : "project"}`}>
              {adds}
            </div>
          </>
        ) : null}
      </section>
      {isArea && !item.builtIn && areaSheet === "settings" ? (
        <AreaSettingsDialog key={`s-${item.updatedAt}`} area={item} open onClose={() => setAreaSheet(null)} />
      ) : null}
      <Dialog
        open={areaSheet === "archive"}
        onClose={() => setAreaSheet(null)}
        title={`Archive ${item.title}?`}
        description="The area and everything filed under it leave the tree and lists. Show archived brings them back; Unarchive restores the area."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAreaSheet(null)} data-autofocus>
              Cancel
            </Button>
            <Button variant="danger" busy={patch.isPending} onClick={() => patch.mutate({ archived: true }, { onSuccess: () => setAreaSheet(null) })}>
              Archive area
            </Button>
          </>
        }
      />

      {container ? (
        <ContainerBody
          d={d}
          items={items}
          rollup={rollup}
          reports={work.rows.filter((row) => row.kind === "job" || row.kind === "report")}
          workOpen={workOpen}
          onToggleWork={toggleWork}
          onSelect={onSelect}
          onOp={onOp}
          canChat={canChat}
          onDialog={setDialog}
          onCopy={() => void copyHandoff()}
        />
      ) : (
        <div className="wk-with-rail min-w-0" data-rail={wide ? "on" : undefined}>
          <div className="min-w-0">
            {section ? null : (
              <div role="tablist" aria-label="Item sections" className="flex gap-5 border-b border-line bg-surface px-3 sm:px-5 lg:px-6">
                {(
                  [
                    ["overview", "Overview"],
                    ["chats", chats.length ? `Chats ${chats.length}` : "Chats"],
                    ["activity", "Activity"],
                  ] as const
                ).map(([k, label], ix, all) => (
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
                        const n = all[(ix + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length][0];
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
            )}
            <div
              role={section ? undefined : "tabpanel"}
              id={section ? undefined : `panel-${tab}`}
              aria-labelledby={section ? undefined : `tab-${tab}`}
              className="wk-panel ip-body px-3 py-3 sm:px-5 lg:px-6 lg:py-4"
            >
              {tab === "overview" ? (
                <>
                  {/* Work: every run, job and report, once. Then what proves it is done, the plan, and one Log line. */}
                  <ItemWorkList
                    itemId={item.id}
                    areaId={d.area?.id ?? null}
                    rows={work.rows}
                    timeline={work.timeline}
                    sessionId={work.sessionId}
                    open={workOpen}
                    onToggle={toggleWork}
                    onOp={onOp}
                  />
                  <DoneWhen d={d} onReopen={() => setDialog("reopen")} focusRecord={initialAction === "validate"} recording={item.status === "awaiting_validation"} />
                  {summary || kidCount || hasBlockers || d.links.length || d.packets.length || adds.length ? (
                    <section className="ip-sec ip-plan" aria-labelledby="ip-plan-h" data-testid="item-plan">
                      <h3 id="ip-plan-h" className="ip-label">
                        Plan
                      </h3>
                      {summary}
                      {kidCount ? (
                        <ItemsSection sub label="Sub-items" testId="sub-items" parent={item} open={kids.items} done={kids.done} onSelect={onSelect} />
                      ) : null}
                      <Blockers d={d} onSelect={onSelect} />
                      <Links d={d} canChat={canChat} />
                      <PacketCard
                        d={d}
                        onCopy={() => void copyHandoff()}
                        onRevise={() => setDialog("packet")}
                        // "Continue in chat" is the page's primary while a packet is ready: not offered twice.
                        onContinue={canChat && shown !== "continue" ? () => setDialog("continue") : undefined}
                      />
                      <div className="ip-adds" role="group" aria-label="Add to this item">
                        {adds}
                      </div>
                    </section>
                  ) : null}
                  <LogLine d={d} onOpen={() => setTab("activity")} />
                </>
              ) : tab === "chats" ? (
                <ItemChats chats={chats} canChat={canChat} onNew={() => newChat.start({ areaId: item.id })} busy={newChat.busy} />
              ) : (
                <Activity d={d} onSelect={onSelect} />
              )}
            </div>
          </div>
          {wide ? <ItemRail d={d} onSelect={onSelect} /> : null}
        </div>
      )}

      <ForkDialog open={dialog === "fork"} onClose={close} item={item} chat={canChat ? chat : undefined} onCreated={onSelect} onOp={onOp} />
      <SplitDialog open={dialog === "split"} onClose={close} item={item} onCreated={onSelect} onOp={onOp} />
      {dialog === "packet" ? <PacketDialog open onClose={close} d={d} /> : null}
      {dialog === "continue" ? <ContinueDialog d={d} markdown={handoffMarkdown(d, window.location.origin)} onClose={close} /> : null}
      <SettleDialog open={dialog === "settle"} onClose={close} d={d} />
      {dialog === "abandoned" || dialog === "superseded" ? <CloseDialog to={dialog} onClose={close} item={item} onOp={onOp} /> : null}
      {aiSheet ? <ActionSheet itemId={item.id} areaId={d.area?.id ?? null} action={aiSheet} onClose={() => setAiSheet(null)} /> : null}
      <ReopenDialog open={dialog === "reopen"} onClose={close} item={item} onFollowUp={onSelect} />
      {dialog === "github_pr" || dialog === "url" ? <LinkDialog kind={dialog} onClose={close} item={item} /> : null}
      {dialog === "adopt" ? <AdoptDialog item={item} onClose={close} /> : null}
      {dialog === "blocker" ? <BlockerDialog d={d} items={items} onClose={close} /> : null}
      {dialog === "dates" ? <DatesDialog key={item.updatedAt} item={item} onClose={close} onOp={onOp} /> : null}
      {dialog === "handoff" ? <HandoffPreviewDialog d={d} onClose={close} /> : null}
      {dialog === "validation" ? (
        <Dialog open onClose={close} title="Add validation" description="What has to be true for this to count as done.">
          <AddValidation itemId={item.id} onDone={close} onTemplate={() => setDialog("templates")} />
        </Dialog>
      ) : null}
      {dialog === "templates" ? <TemplatesDialog itemId={item.id} onClose={close} /> : null}
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

/**
 * Area / project body: Needs you and Working rolled up from everything under it, then its items (an area keeps
 * its project cards and item tree), then whatever it has of its own (checks, packet, blockers, links, reports).
 * No inline Activity: the Activity tab is the one feed.
 */
function ContainerBody({
  d,
  items,
  rollup,
  reports,
  workOpen,
  onToggleWork,
  onSelect,
  onOp,
  canChat,
  onDialog,
  onCopy,
}: {
  d: WorkDetail;
  items: WorkItem[];
  rollup: ContainerRollup;
  /** The container's own AI jobs and reports (e.g. a summary of the project). */
  reports: ItemWorkRow[];
  workOpen: ReadonlySet<string>;
  onToggleWork: (key: string) => void;
  onSelect: (id: string) => void;
  onOp: OnOp;
  canChat: boolean;
  onDialog: (k: DialogKind) => void;
  onCopy: () => void;
}) {
  const { item } = d;
  const isArea = item.parentId === null;
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
  const newChat = useAskHermes();
  // Honour the area's AI policy, regardless of its name.
  const coord =
    isArea && canChat && item.settings?.aiPolicy !== "excluded"
      ? { area: { id: item.id, title: item.title }, chats: itemChatRows(d), onNew: () => newChat.start({ areaId: item.id }), busy: newChat.busy }
      : null;
  // The side column is only drawn when it has something to show.
  const side = !!coord || recent.length > 0 || reports.length > 0 || (!isArea && (d.links.length > 0 || d.blockedBy.length + d.blocking.length > 0));
  return (
    <div className="wk-panel wk-cpage px-3 py-3 sm:px-5 lg:px-6 lg:py-4" data-side={side ? undefined : "none"}>
      <div className="wk-cpage-main ip-body min-w-0">
        <RollupGroups id={item.id} rollup={rollup} onSelect={onSelect} />
        {coord ? <AreaCoordinator variant="sheet" {...coord} /> : null}
        {/* Areas: project cards + item tree (AreaProjects) are the only lists; adding goes through "+ Project" / ⋯ "Add item to area". */}
        {isArea ? (
          <AreaProjects areaId={item.id} onOpen={onSelect} />
        ) : (
          <ItemsSection label="Items" testId="work" parent={item} open={rollup.items} done={rollup.done} onSelect={onSelect} />
        )}
        {usedAsWork ? (
          <>
            <DoneWhen d={d} onReopen={() => onDialog("reopen")} recording={item.status === "awaiting_validation"} />
            <PacketCard d={d} onCopy={onCopy} onRevise={() => onDialog("packet")} onContinue={canChat ? () => onDialog("continue") : undefined} />
          </>
        ) : null}
      </div>
      {/* Side column (≥1100): the coordinator, what moved deeper down, blockers, links, reports. Stacks below on narrower screens. */}
      {side ? (
        <aside className="wk-cpage-side ip-body min-w-0" aria-label={isArea ? "Area coordinator and activity" : "Project details"}>
          {/* Map is Areas: the area coordinator leads the side column at ≥1280 (a sheet below that). */}
          {coord ? <AreaCoordinator variant="column" {...coord} /> : null}
          {recent.length ? (
            <section aria-labelledby="recent-h" className="ip-sec">
              <h3 id="recent-h" className="ip-label">
                Recent activity <span className="ip-count">· {recent.length}</span>
              </h3>
              <ul className="wk-recent">
                {recent.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="tap min-w-0 flex-[1_1_6rem] truncate text-left hover:text-accent" onClick={() => onSelect(i.id)}>
                      {i.title}
                    </button>
                    <span className="max-w-full shrink-0 truncate text-xs text-muted" data-dynamic>
                      {STATUS_LABELS[i.status]} · {fmtWhen(i.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {isArea ? null : (
            <>
              <Blockers d={d} onSelect={onSelect} />
              <Links d={d} canChat={canChat} />
            </>
          )}
          <ItemWorkList label="Reports" itemId={item.id} areaId={d.area?.id ?? null} rows={reports} open={workOpen} onToggle={onToggleWork} onOp={onOp} />
        </aside>
      ) : null}
    </div>
  );
}

/**
 * Compact node header for the Board / Activity / Graph tabs: the breadcrumb and
 * title stay on screen, so switching views never loses where you are.
 */
function NodeHeader({ id, items, onSelect }: { id: string; items: WorkItem[]; onSelect: (id: string) => void }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const node = byId.get(id);
  if (!node) return null;
  const trail: WorkItem[] = [];
  for (let p = node.parentId ? byId.get(node.parentId) : undefined, n = 0; p && n < 50; p = p.parentId ? byId.get(p.parentId) : undefined, n++)
    trail.unshift(p);
  return (
    <header className="px-3 pt-3 sm:px-5 lg:px-6" data-testid="node-header">
      <nav aria-label="Breadcrumb" className="wk-crumbs">
        <ol className="flex flex-wrap items-center gap-0.5 text-xs text-muted">
          {trail.map((b) => (
            <li key={b.id} className="flex items-center gap-0.5">
              <button type="button" className="tap rounded px-1 hover:text-accent hover:underline" onClick={() => onSelect(b.id)}>
                {b.title}
              </button>
              <span aria-hidden="true">›</span>
            </li>
          ))}
          <li aria-current="page" className="px-1">
            {node.parentId === null ? "Area" : node.kind === "thread" ? "Item" : KIND_LABEL[node.kind]}
          </li>
        </ol>
      </nav>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 className="min-w-0 text-lg leading-snug font-semibold tracking-tight break-words lg:text-[19px]">{node.title}</h2>
        {node.parentId === null ? null : <StatusBadge status={node.status} />}
      </div>
    </header>
  );
}

/**
 * The items under a project (or the sub-items under an item): one row per open item with its one headline, then
 * "Done · N" as one tight row that expands. A tag / assignee filter appears once rows carry either. A project's
 * heading carries a quiet "+" that adds in place; with no items yet nothing is drawn (the header's "+ Item" adds).
 */
function ItemsSection({
  label,
  testId,
  parent,
  open,
  done,
  onSelect,
  sub,
}: {
  label: string;
  testId: string;
  parent: WorkItem;
  open: readonly RollupItemRow[];
  done: readonly RollupItemRow[];
  onSelect: (id: string) => void;
  /** Sub-items inside an item's Plan: a smaller heading and no add row (the page's add chips and ⋯ add them). */
  sub?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<ItemFilter>(NO_FILTER);
  const all = [...open, ...done];
  const kept = new Set(
    filterItems(
      all.map((row) => row.item),
      filter,
    ).map((i) => i.id),
  );
  const shownOpen = open.filter((row) => kept.has(row.item.id));
  const shownDone = done.filter((row) => kept.has(row.item.id));
  const count = `· ${open.length} open${done.length ? ` · ${done.length} done` : ""}`;
  return (
    <section aria-labelledby={`kids-${testId}`} className={sub ? "min-w-0" : "ip-sec"} data-testid={`children-${testId}`}>
      {all.length ? (
        <>
          {sub ? (
            <h4 id={`kids-${testId}`} className="ip-sublabel">
              {label} <span>{count}</span>
            </h4>
          ) : (
            <h3 id={`kids-${testId}`} className="ip-label">
              {label} <span className="ip-count">{count}</span>
              {/* The header's "+ Item" opens the full dialog; this adds in place (type "Sub-project / item" to nest). */}
              <span className="ip-label-acts">
                <KButton
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<PlusIcon className="h-4 w-4" />}
                  title="Add item, sub-project or path"
                  onClick={() => setAdding(true)}
                >
                  Add item, sub-project or path
                </KButton>
              </span>
            </h3>
          )}
          <ItemFilterBar rows={all.map((row) => row.item)} value={filter} onChange={setFilter} idPrefix={`kids-${testId}`} className="mb-1.5" />
          <div className="ip-rows">
            <ItemRows open={shownOpen} done={shownDone} onSelect={onSelect} />
          </div>
        </>
      ) : (
        <h3 id={`kids-${testId}`} className="sr-only">
          {label}
        </h3>
      )}
      {!sub && adding ? (
        <div className="ip-inline-add">
          <InlineAdd parent={parent} onDone={() => setAdding(false)} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * ⋯ "Planned dates…": when the work starts and when it is due (and, on an area, its validation default). The
 * title, next action and summary are edited in place on the page, so no form repeats them.
 */
function DatesDialog({ item, onClose, onOp }: { item: WorkItem; onClose: () => void; onOp: OnOp }) {
  const isArea = item.parentId === null;
  const [f, setF] = useState({
    startDate: item.startDate ?? "",
    targetDate: item.targetDate ?? "",
    validationDefault: (item.validationDefault ?? "") as "" | "required" | "optional",
  });
  const save = useWorkMutation(
    () =>
      api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}`, {
        startDate: f.startDate || null,
        targetDate: f.targetDate || null,
        ...(isArea && f.validationDefault !== (item.validationDefault ?? "") ? { validationDefault: f.validationDefault || null } : {}),
      }),
    {
      ok: "Saved",
      onSuccess: (r) => {
        onOp(r.op);
        onClose();
      },
    },
  );
  const ruleDefault = areaValidationDefault({ ...item, validationDefault: null, systemKey: item.builtIn ? "misc" : null });
  const dirty =
    f.startDate !== (item.startDate ?? "") || f.targetDate !== (item.targetDate ?? "") || (isArea && f.validationDefault !== (item.validationDefault ?? ""));
  return (
    <Dialog
      open
      onClose={onClose}
      title={isArea ? "Area details" : "Planned dates"}
      footer={
        <>
          <KButton onClick={onClose}>Cancel</KButton>
          <KButton variant="primary" type="submit" form="wi-form" disabled={!dirty} loading={save.isPending}>
            Save
          </KButton>
        </>
      }
    >
      <form
        id="wi-form"
        className="grid gap-3 sm:grid-cols-2"
        data-testid="work-details"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field id="wi-start" label="Start date">
          <Input id="wi-start" type="date" className="w-full min-w-0" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field id="wi-target" label="Target date">
          <Input id="wi-target" type="date" className="w-full min-w-0" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />
        </Field>
        {isArea ? (
          <div className="sm:col-span-2">
            <Field
              id="wi-vdefault"
              label="Validation"
              hint="What “Start focused work” preselects for new packets in this area. You can override it per packet."
            >
              <Select
                id="wi-vdefault"
                className="w-full min-w-0"
                value={f.validationDefault}
                onChange={(e) => setF({ ...f, validationDefault: e.target.value as "" | "required" | "optional" })}
              >
                <option value="">Default for this area ({ruleDefault === "required" ? "required" : "optional"})</option>
                <option value="required">Required</option>
                <option value="optional">Optional</option>
              </Select>
            </Field>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Copies the item's handoff (packet, links and validations as Markdown) for pasting into another tool. */
function useCopyHandoff(d: WorkDetail | undefined) {
  const { toast } = useToast();
  return async () => {
    if (!d) return;
    try {
      await navigator.clipboard.writeText(handoffMarkdown(d, window.location.origin));
      toast("Handoff copied", "ok");
    } catch {
      toast("Couldn't copy. Use Preview handoff.", "warn");
    }
  };
}

/** ⋯ "Preview handoff" while the item has no packet yet (the packet block carries its own preview). */
function HandoffPreviewDialog({ d, onClose }: { d: WorkDetail; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} size="lg" title="Handoff preview" description="What Copy handoff and Continue in new conversation send.">
      <pre data-testid="handoff-preview" className="max-h-96 overflow-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap">
        {handoffMarkdown(d, window.location.origin)}
      </pre>
    </Dialog>
  );
}

/**
 * Plan > Work packet: the hand-off snapshot. Drawn only once a packet exists; before that the ⋯ menu covers copy,
 * preview and continue, and "Start focused work" writes the first one.
 */
function PacketCard({ d, onCopy, onRevise, onContinue }: { d: WorkDetail; onCopy: () => void; onRevise: () => void; onContinue?: () => void }) {
  const p = d.packets[0];
  if (!p) return null;
  // Client-only: this block renders after the detail query resolves in the browser.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className="ip-packet wk-packet">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h4 className="ip-sublabel mt-0">
          Work packet{" "}
          <span data-dynamic>
            v{p.version} · {fmtDate(p.createdAt)}
          </span>
        </h4>
        <div className="flex flex-wrap items-center gap-1">
          <KButton size="sm" variant="ghost" onClick={onCopy}>
            Copy handoff
          </KButton>
          <KButton size="sm" variant="ghost" onClick={onRevise}>
            New revision
          </KButton>
          {onContinue ? (
            <KButton size="sm" variant="ghost" onClick={onContinue}>
              Continue in new conversation
            </KButton>
          ) : null}
        </div>
      </div>
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
      <details className="mt-2 text-sm">
        <summary className="tap cursor-pointer text-accent">Preview handoff</summary>
        <pre data-testid="handoff-preview" className="mt-2 max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap">
          {handoffMarkdown(d, origin)}
        </pre>
      </details>
    </div>
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

/**
 * Done when (the item's validations): a checklist. Not drawn while there are none. A row opens to record a
 * result, waive or remove it; while the item is awaiting validation the lines still to measure are already open.
 * Settling is the page's one primary action (the Now slot), never a button here.
 */
function DoneWhen({ d, onReopen, focusRecord, recording }: { d: WorkDetail; onReopen: () => void; focusRecord?: boolean; recording: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!d.validations.length) return null;
  const failed = d.validations.some((v) => v.status === "fail");
  const overdue = d.validations.filter((v) => v.overdue).length;
  const met = d.validations.filter((v) => v.status === "pass" || v.status === "waived").length;
  const first = Math.max(
    0,
    d.validations.findIndex((x) => x.status === "pending" || x.status === "fail"),
  );
  return (
    <section id="work-validations" className="ip-sec scroll-mt-4" aria-labelledby="ip-done-h">
      <h3 id="ip-done-h" className="ip-label">
        Done when{" "}
        <span className="ip-count">
          · {met} of {d.validations.length}
        </span>
        {/* IT3: overdue is a compact header note + red due text on the row, not a banner. */}
        {overdue ? (
          <span className="ip-label-note text-danger" data-testid="validation-overdue">
            · {overdue} overdue
          </span>
        ) : null}
      </h3>
      {failed && d.item.status !== "reopened" ? (
        <div className="ip-note">
          <span>A validation failed.</span>
          <KButton size="sm" onClick={onReopen}>
            Reopen with failed evidence
          </KButton>
        </div>
      ) : null}
      <ul className="ip-checks">
        {d.validations.map((v, i) => {
          const focus = !!focusRecord && i === first;
          // While the item waits on validation, what still has to be measured (or measured again) is open.
          const shown = open[v.id] ?? (focus || (recording && (v.status === "pending" || v.status === "fail")));
          return <ValidationRow key={v.id} v={v} focus={focus} open={shown} onToggle={() => setOpen((o) => ({ ...o, [v.id]: !shown }))} />;
        })}
      </ul>
    </section>
  );
}

function AddValidation({ itemId, onDone, onTemplate }: { itemId: string; onDone: () => void; onTemplate: () => void }) {
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
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined);
      }}
    >
      <div className="flex justify-end sm:col-span-2">
        <KButton size="sm" variant="ghost" onClick={onTemplate}>
          Add from template
        </KButton>
      </div>
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

const V_WORD = { pending: "Pending", pass: "Pass", fail: "Fail", waived: "Waived" } as const;

/**
 * One "done when" check, as a checklist line: a box (ticked when it passed, crossed when it failed, struck when
 * waived), what must hold, and what was measured. It opens in place to record a result, waive or remove it.
 */
function ValidationRow({ v, focus, open, onToggle }: { v: WorkValidation; focus?: boolean; open: boolean; onToggle: () => void }) {
  const panel = useId();
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
  const unit = v.unit ? ` ${v.unit}` : "";
  const label = `${v.metric} ${CMP_TEXT[v.comparator] ?? v.comparator} ${v.threshold}${unit}`;
  // Line two only says what line one cannot: the baseline, when it is due, why it was waived.
  const second = [
    v.baseline !== null ? `baseline ${v.baseline}${unit}` : "",
    v.status === "pending" && v.dueDate ? `${v.overdue ? "overdue since" : "due"} ${shortDate(v.dueDate)}` : "",
    v.waiverReason ? `waived: ${v.waiverReason}` : "",
  ].filter(Boolean);
  return (
    <li className="ip-check" data-testid="validation-row" data-status={v.status} data-overdue={v.overdue || undefined} data-open={open || undefined}>
      <KButton variant="ghost" className="ip-check-hit" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={onToggle}>
        <span className="ip-check-box" aria-hidden="true">
          {v.status === "pass" ? <CheckIcon className="h-3.5 w-3.5" /> : v.status === "fail" ? "×" : v.status === "waived" ? "–" : null}
        </span>
        <span className="ip-check-main">
          <span className="ip-check-t">{label}</span>
          {second.length ? (
            <span className="ip-check-s" data-dynamic>
              {second.join(" · ")}
            </span>
          ) : null}
        </span>
        <span className="ip-check-result" data-dynamic>
          <span className="sr-only">{V_WORD[v.status]}: </span>
          {v.status === "waived" ? "Waived" : v.observed !== null ? `${v.observed}${unit}` : "Not measured"}
        </span>
      </KButton>
      {open ? (
        <div className="ip-check-open" id={panel}>
          {v.evidenceUrl ? (
            <a href={v.evidenceUrl} target="_blank" rel="noreferrer noopener" className="ip-link text-xs break-all">
              Evidence<span className="sr-only"> for {v.metric} (opens in a new tab)</span>
            </a>
          ) : null}
          <form
            className="ip-vform"
            onSubmit={(e) => {
              e.preventDefault();
              record.mutate(undefined);
            }}
          >
            <Input
              id={`obs-${v.id}`}
              // "Record result" from Today or the command palette lands here.
              autoFocus={focus}
              inputMode="decimal"
              aria-label={`Observed value for ${v.metric}`}
              type="number"
              step="any"
              className="w-full min-w-0"
              placeholder={`Observed${v.unit ? ` (${v.unit})` : ""}`}
              value={observed}
              onChange={(e) => setObserved(e.target.value)}
            />
            <Input
              id={`ev-${v.id}`}
              type="url"
              aria-label={`Evidence link for ${v.metric}`}
              className="w-full min-w-0"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="Evidence link (https://…)"
            />
            <span className="ip-vform-acts">
              <KButton type="submit" size="sm" loading={record.isPending} aria-label={`Record ${v.metric}`}>
                Record
              </KButton>
              <KButton size="sm" variant="ghost" onClick={() => setWaiving(true)} aria-label={`Waive ${v.metric}`}>
                Waive…
              </KButton>
              <KButton size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate(undefined)} aria-label={`Remove ${v.metric}`}>
                Remove
              </KButton>
            </span>
          </form>
        </div>
      ) : null}
      <Dialog
        open={waiving}
        onClose={() => setWaiving(false)}
        title={`Waive ${v.metric}`}
        description="Waivers are recorded with your reason."
        footer={
          <>
            <KButton onClick={() => setWaiving(false)}>Cancel</KButton>
            <KButton variant="primary" disabled={!reason.trim()} loading={waive.isPending} onClick={() => waive.mutate(undefined)}>
              Waive
            </KButton>
          </>
        }
      >
        <Field id={`wv-${v.id}`} label="Reason">
          <Textarea id={`wv-${v.id}`} data-autofocus className="w-full min-w-0" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </li>
  );
}

/** Plan > Blockers: what this waits on, and what waits on it. Drawn only when there is one. */
function Blockers({ d, onSelect }: { d: WorkDetail; onSelect: (id: string) => void }) {
  const remove = useWorkMutation((depId: string) => api.del(`/api/work/dependencies/${encodeURIComponent(depId)}`), { ok: "Dependency removed" });
  if (!d.blockedBy.length && !d.blocking.length) return null;
  const openBlockers = d.blockedBy.filter((b) => b.open).length;
  const row = (r: DependencyRef, label: string) => (
    <li key={r.dependencyId} className="ip-dep">
      <span className="ip-dep-main">
        <span className="ip-dep-rel">{label}</span>
        <Link
          href={`/areas?item=${encodeURIComponent(r.id)}`}
          className="ip-dep-title"
          data-done={r.open ? undefined : ""}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onSelect(r.id);
          }}
        >
          {r.title}
        </Link>
        <StatusBadge status={r.status} />
      </span>
      <KButton size="sm" variant="ghost" onClick={() => remove.mutate(r.dependencyId)} aria-label={`${label} ${r.title}: remove`}>
        Remove
      </KButton>
    </li>
  );
  return (
    <div data-testid="work-deps" className="scroll-mt-4">
      <h4 className="ip-sublabel">
        Blockers <span>· {openBlockers ? `${openBlockers} open` : "none open"}</span>
      </h4>
      <ul className="ip-deps">
        {d.blockedBy.map((r) => row(r, "Blocked by"))}
        {d.blocking.map((r) => row(r, "Blocks"))}
      </ul>
    </div>
  );
}

/** "Blocker" add chip / ⋯ "Add blocker…": pick the work this has to wait for. */
function BlockerDialog({ d, items, onClose }: { d: WorkDetail; items: WorkItem[]; onClose: () => void }) {
  const [dest, setDest] = useState("");
  const add = useWorkMutation(() => api.post(`/api/work/items/${encodeURIComponent(d.item.id)}/dependencies`, { dependsOnId: dest }), {
    ok: "Dependency added",
    onSuccess: onClose,
  });
  const taken = new Set([d.item.id, ...d.blockedBy.map((b) => b.id)]);
  const options = itemPaths(
    items.filter((i) => i.parentId !== null && !i.archived),
    taken,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a blocker"
      description="Work this has to wait for."
      footer={
        <>
          <KButton onClick={onClose}>Cancel</KButton>
          <KButton variant="primary" type="submit" form="dep-form" disabled={!dest} loading={add.isPending}>
            Add dependency
          </KButton>
        </>
      }
    >
      <form
        id="dep-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (dest) add.mutate(undefined);
        }}
      >
        <Field id="dep-add" label="Depends on">
          <Select id="dep-add" data-autofocus className="w-full min-w-0" value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}

/** Plan > Links: conversations, pull requests (state, checks, live or not) and URLs. Drawn only when there is one. */
function Links({ d, canChat }: { d: WorkDetail; canChat: boolean }) {
  const hasChat = d.links.some((l) => l.kind === "chat_session");
  const convs = useConversations(canChat && hasChat);
  if (!d.links.length) return null;
  const activity = new Map((convs.data?.conversations ?? []).map((c) => [c.id, c.lastActiveAt]));
  const prs = d.links.filter((l) => l.kind === "github_pr" || l.kind === "github_issue").length;
  const chats = d.links.filter((l) => l.kind === "chat_session").length;
  const meta = [
    prs ? `${prs} PR${prs === 1 ? "" : "s"}` : "",
    chats ? `${chats} chat${chats === 1 ? "" : "s"}` : "",
    d.links.length - prs - chats ? `${d.links.length - prs - chats} other` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div data-testid="work-links">
      <h4 className="ip-sublabel">
        Links <span>· {meta}</span>
      </h4>
      <ul className="ip-links">
        {d.links.map((l) => (
          <LinkRow
            key={l.id}
            l={l}
            refresh={d.githubRefresh}
            deploy={l.kind === "github_pr" ? deployOf(l.externalState, d.item) : null}
            lastActive={l.kind === "chat_session" ? activity.get(l.targetId ?? "") : undefined}
          />
        ))}
      </ul>
      {!d.githubRefresh && prs ? (
        <p className="mt-1.5 text-xs text-muted">
          Add a GitHub token (Settings → Connections → GitHub) to refresh PR state from GitHub (read-only). Until then, mark it yourself.
        </p>
      ) : null}
    </div>
  );
}

function LinkRow({ l, refresh, lastActive, deploy }: { l: WorkLink; refresh: boolean; lastActive?: string | null; deploy?: "live" | "waiting" | null }) {
  const url = `/api/work/links/${encodeURIComponent(l.id)}`;
  const state = useWorkMutation((externalState: "open" | "merged" | "closed") => api.patch(url, { externalState }), {
    ok: l.kind === "github_issue" ? "Issue state updated" : "PR state updated",
  });
  const remove = useWorkMutation(() => api.del(url), { ok: "Link removed" });
  const pull = useWorkMutation(() => api.post(`${url}/refresh`), { ok: "Refreshed from GitHub" });
  const name = l.title || l.targetId || l.url || "";
  const kind = linkKind(l);
  const smart = useSmartSettings();
  const [reviewing, setReviewing] = useState(false);
  const menu = useAnchoredMenu();
  // PR state can be set by hand until GitHub is connected; everything rarer is in the row's ⋯.
  const more: KMenuItem[] = [
    ...(l.kind === "github_pr" && l.targetId && smart.data?.enabled ? [{ label: "Review card", onSelect: () => setReviewing(true) }] : []),
    ...(l.kind === "github_pr" && l.externalState === "open" ? [{ label: "Mark closed", onSelect: () => state.mutate("closed") }] : []),
    ...(l.kind === "github_issue"
      ? [
          {
            label: l.externalState === "closed" ? "Mark open" : "Mark closed",
            onSelect: () => state.mutate(l.externalState === "closed" ? "open" : "closed"),
          },
        ]
      : []),
    ...((l.kind === "github_pr" || l.kind === "github_issue") && refresh ? [{ label: "Refresh from GitHub", onSelect: () => pull.mutate(undefined) }] : []),
    { label: "Remove link", onSelect: () => remove.mutate(undefined), danger: true },
  ];
  return (
    <li className="ip-linkrow" data-testid="link-row" data-kind={kind}>
      <div className="ip-linkrow-main">
        {/* Line one: what it is (Artifact, Design, Pull request, Conversation…), then its name, which opens it. */}
        <p className="ip-linkrow-t">
          <Pill tone={kind === "Pull request" || kind === "Issue" ? "ac" : kind === "Conversation" ? "ai" : kind === "Link" ? "neutral" : "inf"}>
            <span data-testid="link-kind">{kind}</span>
          </Pill>
          {l.kind === "chat_session" ? (
            <Link href={`/chat/${encodeURIComponent(l.targetId ?? "")}`} className="ip-linkrow-name" aria-label={`Open conversation: ${name}`}>
              {name}
            </Link>
          ) : l.url ? (
            <a href={l.url} target="_blank" rel="noreferrer noopener" className="ip-linkrow-name" aria-label={`Open: ${name} (opens in a new tab)`}>
              {name}
            </a>
          ) : (
            <span className="ip-linkrow-name">{name}</span>
          )}
        </p>
        {/* Line two: its role on the item and how it stands. */}
        <p className="ip-linkrow-s">
          <span>
            {l.role}
            {l.lineage === "handoff_from" ? " · started from the handoff" : ""}
          </span>
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
          {deploy ? (
            <Badge tone={deploy === "live" ? "ok" : "warn"}>
              <span data-testid="link-deploy">{deploy === "live" ? "live" : "not live yet"}</span>
            </Badge>
          ) : null}
          {(l.kind === "github_pr" || l.kind === "github_issue") && l.checkedAt ? (
            <span className={l.checkError ? "text-danger" : undefined} data-dynamic>
              {l.checkError ? `GitHub check failed ${fmtWhen(l.checkedAt)}: ${l.checkError}` : `Checked on GitHub ${fmtWhen(l.checkedAt)}`}
            </span>
          ) : null}
          {l.kind === "chat_session" ? <span data-dynamic>Last activity {lastActive ? fmtWhen(lastActive) : "unknown"}</span> : null}
        </p>
      </div>
      <span className="ip-linkrow-acts">
        {l.kind === "github_pr" && l.externalState !== "merged" ? (
          <KButton size="sm" variant="ghost" onClick={() => state.mutate("merged")} loading={state.isPending}>
            Mark merged
          </KButton>
        ) : null}
        <MenuButton menu={menu} label={`More for ${name}`} />
        <AnchoredMenu menu={menu} label={`More for ${name}`} items={more} />
      </span>
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

function CloseDialog({ to, onClose, item, onOp }: { to: CloseStatus; onClose: () => void; item: WorkItem; onOp: OnOp }) {
  const [reason, setReason] = useState("");
  const abandon = to === "abandoned";
  const close = useWorkMutation(
    () => api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}`, { status: to, reason: reason.trim() || undefined }),
    {
      ok: abandon ? "Abandoned" : "Marked superseded",
      onSuccess: (r) => {
        onOp(r.op);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${abandon ? "Abandon" : "Mark superseded:"} ${item.title}`}
      description={abandon ? "Closes it without settling. You can reopen any time." : "Closes it because other work replaced it. You can reopen any time."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={close.isPending} onClick={() => close.mutate(undefined)}>
            {abandon ? "Abandon" : "Mark superseded"}
          </Button>
        </>
      }
    >
      <Field id="cl-reason" label={abandon ? "Why stop? (optional)" : "Replaced by what? (optional)"}>
        <textarea id="cl-reason" data-autofocus className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} />
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
        <ActivityFeed scope={{ item: item.id, descendants: isContainer(item) && item.kind !== "conversation" }} onSelect={onSelect} compact />
      </Card>
    </>
  );
}

/** Desktop bulk select: a flat, indented checkbox list of the tree (the sidebar owns the tree itself). */
function SelectList({ items, selection, onToggle }: { items: WorkItem[]; selection: Set<string>; onToggle: (id: string) => void }) {
  const live = items.filter((i) => !i.builtIn && !i.archived);
  const kids = new Map<string | null, WorkItem[]>();
  const ids = new Set(live.map((i) => i.id));
  for (const i of live) {
    const k = i.parentId && ids.has(i.parentId) ? i.parentId : null;
    kids.set(k, [...(kids.get(k) ?? []), i]);
  }
  const rows: { item: WorkItem; depth: number }[] = [];
  const walk = (p: string | null, depth: number) => {
    for (const i of kids.get(p) ?? []) {
      rows.push({ item: i, depth });
      walk(i.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <div className="min-w-0">
      <p className="mb-2 text-sm text-muted">Pick rows, then Move to… or Archive.</p>
      <ul className="max-w-2xl divide-y divide-line rounded-[10px] border border-line bg-surface">
        {rows.map(({ item, depth }) => (
          <li key={item.id}>
            <label
              className="flex min-h-9 cursor-pointer items-center gap-2 px-3 py-1 text-[13.5px] hover:bg-surface-2"
              style={{ paddingLeft: `${12 + depth * 18}px` }}
            >
              <input type="checkbox" checked={selection.has(item.id)} onChange={() => onToggle(item.id)} />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-xs text-muted">{KIND_LABELS[item.kind] ?? item.kind}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
