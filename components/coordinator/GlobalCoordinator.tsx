"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { ActivityItem } from "@/lib/activity";
import type { ItemsResponse, WorkItem } from "@/lib/work";
import { relativeTime } from "@/lib/time";
import { sortByUrgency } from "@/lib/cw-decisions";
import { coordinatorStatus } from "@/lib/coordinator/status";
import { sinceRunCounts } from "@/lib/coordinator/run-card";
import { BoltIcon, ChevronIcon, InboxIcon } from "@/components/icons";
import { pageContext } from "@/lib/coordinator/page-context";
import { sessionIdFromRoute } from "@/lib/composer-target";
import { usePanelOwner } from "@/lib/client/panel-owner";
import { AgentChip } from "@/components/agents/AgentChip";
import { WhileAwayCard } from "@/components/agents/WhileAwayCard";
import { OPEN_COORDINATOR_EVENT, OPEN_PALETTE_EVENT } from "@/components/navigation/commands";
import { CoordinatorThread, type CoordinatorResponse } from "./CoordinatorThread";
import { QuickActionChips } from "@/components/quick-actions/QuickActionChips";
import { COORDINATOR_PROMPT, QUICK_ACTION_MANAGE, type QuickActionContext } from "@/lib/quick-actions";
import { useCoordinatorThings } from "./useCoordinatorThings";
import { pickTrayLine, type PriorityLine } from "@/lib/coordinator/things";
import type { DynamicCard, DynamicResponse } from "@/lib/jarvis-ui/dynamic";
import { useSmartSettings } from "@/components/smart/AssistantText";
import { DynamicSurface } from "@/components/smart/DynamicSurface";
import { Button, SectionHeader, useNow, useToast } from "@/components/ui";
import { NeedsPanel } from "./needs/NeedsPanel";
import { useCoordinatorDecisions } from "./needs/useCoordinatorDecisions";
import { RunningPanel } from "./running/RunningPanel";
import { useCoordinatorRuns, useMarkLooked } from "./running/useCoordinatorRuns";
import "./coordinator.css";

const clamp = (width: number) => Math.min(520, Math.max(300, width));
const subscribeWide = (cb: () => void) => {
  const m = window.matchMedia("(min-width: 900px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const getWide = () => window.matchMedia("(min-width: 900px)").matches;
/** "running" is the Activity tab: runs (working, stuck, finished) plus what the Chief of staff changed. */
type Tab = "chat" | "needs" | "running";
const TAB_KEYS: Record<string, Tab> = { n: "needs", r: "running", a: "running", c: "chat" };
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const ASK_PAGE = "Help me understand this page and suggest the next action.";

/** One host in AppShell, independent of page navigation. No sends without owner action. */
export function GlobalCoordinator() {
  const pathname = usePathname();
  const search = useSearchParams();
  const pageKey = pathname + "?" + search.toString();
  const wide = useSyncExternalStore(subscribeWide, getWide, () => false);
  const chat = pathname === "/chat" || pathname.startsWith("/chat/");
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(360);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [chatExpandedOn, setChatExpandedOn] = useState<string | null>(null);
  const [removedOn, setRemovedOn] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [draft, setDraft] = useState("");
  /** D-n / R-n a tray tap, deep link or chip opened (the panel starts on it). */
  const [focusRef, setFocusRef] = useState<{ tab: Tab; ref?: string; n: number } | null>(null);
  const [chatSince, setChatSince] = useState<string | null>(null);
  const gPending = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const { things, line: priority, awayLine, markSeen, error } = useCoordinatorThings();
  const smart = useSmartSettings();
  const requestedCard = search.get("smartCard");
  const dynamic = useQuery({
    queryKey: ["smart-dynamic", requestedCard],
    queryFn: () => api.get<DynamicResponse>(`/api/smart/dynamic${requestedCard ? `?card=${encodeURIComponent(requestedCard)}` : ""}`),
    enabled: smart.data?.enabled === true,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const [activeCard, setActiveCard] = useState<DynamicCard>();
  const [snoozed, setSnoozed] = useState<string[]>([]);
  const cwDecisions = useCoordinatorDecisions();
  const cwRuns = useCoordinatorRuns();
  const { mutate: markLooked } = useMarkLooked();
  const now = useNow();
  // Needs you = open D-n rows + run approvals / workflow proposals + stalled runs: the same things, and the same
  // number, that Today and the sidebar call "Needs you". Stalled runs get one compact line each here and their
  // full row (log, steer, stop) under Activity.
  const otherAsks = things.decisions.filter((e) => !/^(item|decision|stalled):/.test(e.key));
  const stalledAsks = things.decisions.filter((e) => e.key.startsWith("stalled:"));
  const needsCount = cwDecisions.data ? cwDecisions.data.counts.open + otherAsks.length + stalledAsks.length : things.needsYou;
  // Hermes/job runs and failing PR checks have no R-n row: keep them reachable under Activity.
  const runRows = cwRuns.data?.runs ?? [];
  const cwRunIds = new Set(runRows.map((r) => r.id));
  const otherRuns = [...things.running, ...things.failing.filter((f) => !things.running.some((r) => r.id === f.id))].filter((r) => !cwRunIds.has(r.id));
  const stillFailing = new Set(things.failing.map((f) => f.id));
  const topDecision = sortByUrgency(
    (cwDecisions.data?.decisions ?? []).filter((d) => d.state === "open"),
    new Date(now),
  )[0];
  // One honest status for the tray, the strip and the tab badges (lib/coordinator/status.ts).
  const status = coordinatorStatus({
    needs: needsCount,
    topQuestion: topDecision?.question ?? otherAsks[0]?.question,
    topRef: topDecision?.ref,
    runs: runRows,
    otherRuns: otherRuns.filter((r) => r.state !== "failed" || stillFailing.has(r.id)),
    finished: things.doneUnseen,
    lastLooked: cwRuns.data?.lastLooked.running,
    now,
  });
  // Smart cards never displace a new failure or something waiting on the owner; the away digest keeps its own line.
  const cardBase: PriorityLine = {
    ...priority,
    state: status.state === "failed" ? "failing" : status.state === "needs" ? "needs" : "idle",
  };
  const line = pickTrayLine(cardBase, awayLine ? [] : (dynamic.data?.cards ?? []), snoozed);
  const tray = line.card
    ? { state: "card", tone: line.tone, dot: line.dot, text: line.card.line.text, rest: "" }
    : awayLine
      ? { state: priority.state === "failing" ? "failed" : priority.state, tone: priority.tone, dot: priority.dot, text: priority.text, rest: "" }
      : { state: status.state, tone: status.tone, dot: status.dot, text: status.text, rest: status.rest };
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("jarvis.smart.snoozed") ?? "null") as { day?: string; ids?: string[] } | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- day-scoped browser preference
      setSnoozed(saved?.day === dynamic.data?.today && Array.isArray(saved?.ids) ? saved.ids : []);
    } catch {
      /* optional */
    }
  }, [dynamic.data?.today]);
  const dismissCard = () => {
    if (!activeCard) return;
    const ids = [...snoozed, activeCard.id];
    setSnoozed(ids);
    setActiveCard(undefined);
    try {
      localStorage.setItem("jarvis.smart.snoozed", JSON.stringify({ day: dynamic.data?.today, ids }));
    } catch {
      /* optional */
    }
  };
  const info = useQuery({
    queryKey: ["work", "coordinator", "global"],
    queryFn: () => api.get<(CoordinatorResponse & { scope: "global" }) | { area: null }>("/api/work/coordinator/global"),
    refetchInterval: 30_000,
  });
  const selected = pathname.startsWith("/areas") || pathname.startsWith("/work") ? (search.get("item") ?? search.get("node")) : null;
  const sessionId = sessionIdFromRoute(pathname);
  const items = useQuery({ queryKey: ["work", "items", false], queryFn: () => api.get<ItemsResponse>("/api/work/items"), enabled: !!selected || !!sessionId });
  const chain: WorkItem[] = [];
  const selectedId = selected ?? (sessionId ? items.data?.items.find((i) => i.sessionId === sessionId)?.id : null);
  if (selectedId) {
    const byId = new Map((items.data?.items ?? []).map((i) => [i.id, i]));
    const visited = new Set<string>();
    for (let current = byId.get(selectedId); current && !visited.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
      visited.add(current.id);
      chain.unshift(current);
    }
  }
  const area = chain[0]?.parentId === null ? chain[0] : null;
  const context =
    sessionId && (!items.isSuccess || (selectedId && !area))
      ? null
      : pageContext(pathname, search.toString(), {
          area: area ? { ...area, aiPolicy: area.settings?.aiPolicy } : null,
          item: chain.at(-1),
          parents: chain.slice(1, -1).map((i) => i.title),
        });
  const attached = removedOn === pageKey ? null : context;
  const quickContext: QuickActionContext = { areaId: area?.id, areaTitle: context && area ? area.title : undefined, pageLabel: context?.label, path: pathname };
  const panelOwner = usePanelOwner();
  // A chat panel owning the right side collapses the rail to its strip; an explicit open on this page still wins.
  const expanded = open && (!(chat && panelOwner) || chatExpandedOn === pageKey);
  const railWidth = expanded ? width : 54;
  const saveOpen = (value: boolean) => {
    setOpen(value);
    try {
      localStorage.setItem("jarvis.gc.open", String(value));
    } catch {
      /* storage optional */
    }
  };
  const saveWidth = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    try {
      localStorage.setItem("jarvis.gc.width", String(next));
    } catch {
      /* storage optional */
    }
  };
  const show = () => {
    setActiveCard(undefined);
    saveOpen(true);
    setChatExpandedOn(pageKey);
    setPhoneOpen(true);
  };
  const selectTab = (next: Tab) => {
    setTab(next);
    if (next === "running") markSeen();
  };
  const openAt = (next: Tab, ref?: string) => {
    show();
    selectTab(next);
    setFocusRef((f) => ({ tab: next, ref, n: (f?.n ?? 0) + 1 }));
  };
  const showPriority = () => {
    if (line.card) {
      show();
      setActiveCard(line.card);
    } else if (awayLine) {
      show();
      setTab("chat");
    } else openAt(status.target.tab, status.target.ref);
  };
  const prefill = (value: string) => {
    setActiveCard(undefined);
    setTab("chat");
    setDraft(value.slice(0, 8000));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const input = host.current?.ownerDocument.querySelector<HTMLTextAreaElement>('[data-testid="gc-input"]');
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }),
    );
  };
  const onRef = (ref: string) => openAt(ref.startsWith("D-") ? "needs" : "running", ref);
  const onPanelKey = (e: ReactKeyboardEvent) => {
    if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (gPending.current) {
      gPending.current = false;
      const next = TAB_KEYS[e.key];
      if (next) {
        e.preventDefault();
        setActiveCard(undefined);
        selectTab(next);
        requestAnimationFrame(() => document.getElementById(`${ids}-${next}`)?.focus());
      }
      return;
    }
    if (e.key === "g") {
      gPending.current = true;
      setTimeout(() => (gPending.current = false), 1200);
    }
  };
  const hide = () => {
    if (wide) {
      saveOpen(false);
      setChatExpandedOn(null);
    } else setPhoneOpen(false);
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- page-scoped opt-out and sheet/strip reset on navigation
    setRemovedOn(null);
    setChatExpandedOn(null);
    setPhoneOpen(false);
  }, [pageKey]);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate browser preferences after SSR
      setOpen(localStorage.getItem("jarvis.gc.open") !== "false");
      const saved = Number(localStorage.getItem("jarvis.gc.width"));
      if (saved && Number.isFinite(saved)) setWidth(clamp(saved));
    } catch {
      /* storage optional */
    }
  }, []);
  useEffect(() => {
    const onOpen = () => {
      setActiveCard(undefined);
      setTab("chat");
      setOpen(true);
      setChatExpandedOn(pageKey);
      setPhoneOpen(true);
      try {
        localStorage.setItem("jarvis.gc.open", "true");
      } catch {
        /* optional */
      }
    };
    // ⌘K quick action: open the rail/sheet and fill the composer. Never sends.
    const onPrompt = (e: Event) => {
      const value = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof value !== "string") return;
      if (document.querySelector('[data-testid="coordinator-pane"]')) return; // an open area pane takes it
      onOpen();
      setTab("chat");
      setDraft(value.slice(0, 8000));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => host.current?.ownerDocument.querySelector<HTMLTextAreaElement>('[data-testid="gc-input"]')?.focus()),
      );
    };
    // The phone sheet is a native modal (top layer, rest of the app inert): close it so the
    // app-shell palette and "Manage quick actions" dialog are reachable. Close the native
    // top layer synchronously, before either destination tries to focus its input.
    const onManage = () => {
      dialog.current?.close();
      setPhoneOpen(false);
    };
    window.addEventListener(OPEN_COORDINATOR_EVENT, onOpen);
    window.addEventListener(COORDINATOR_PROMPT, onPrompt);
    window.addEventListener(QUICK_ACTION_MANAGE, onManage);
    window.addEventListener(OPEN_PALETTE_EVENT, onManage);
    return () => {
      window.removeEventListener(OPEN_COORDINATOR_EVENT, onOpen);
      window.removeEventListener(COORDINATOR_PROMPT, onPrompt);
      window.removeEventListener(QUICK_ACTION_MANAGE, onManage);
      window.removeEventListener(OPEN_PALETTE_EVENT, onManage);
    };
  }, [pageKey]);
  useEffect(() => {
    const shell = host.current?.closest<HTMLElement>(".jv-shell");
    shell?.style.setProperty("--gc-w", `${wide ? railWidth : 0}px`);
    if (tray.dot) shell?.setAttribute("data-gc-dot", tray.dot);
    else shell?.removeAttribute("data-gc-dot");
    return () => {
      shell?.style.removeProperty("--gc-w");
      shell?.removeAttribute("data-gc-dot");
    };
  }, [wide, railWidth, tray.dot]);
  useEffect(() => {
    if (wide || !phoneOpen) return;
    const element = dialog.current;
    const restore = document.activeElement as HTMLElement | null;
    element?.showModal(); // native modal: focus trap + inert background
    element?.querySelector<HTMLElement>("[data-gc-close]")?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      restore?.focus();
    };
  }, [wide, phoneOpen]);
  const coord = search.get("coord");
  const coordRef = search.get("d") ?? search.get("r") ?? undefined;
  const openedCoord = useRef<string | null>(null);
  const openCoord = useEffectEvent((next: Tab, ref?: string) => openAt(next, ref));
  useEffect(() => {
    const key = `${coord}:${coordRef ?? ""}`;
    if (!coord || openedCoord.current === key) return;
    // "changes" predates the merged Activity tab; old links still land where the changes are.
    const next: Tab | null = coord === "needs" ? "needs" : coord === "running" || coord === "changes" ? "running" : coord === "chat" ? "chat" : null;
    if (!next) return;
    openedCoord.current = key;
    const ref = coordRef && /^[DR]-\d{1,9}$/.test(coordRef) ? coordRef : undefined;
    // A push / notification deep link explicitly opens the sheet or rail at its target.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a deep link opens its host once per URL
    openCoord(next, ref);
  }, [coord, coordRef]);
  // Chat "Since HH:MM" divider: snapshot the previous chat look when the chat becomes visible, then mark it.
  const chatVisible = (wide ? open : phoneOpen) && tab === "chat" && !activeCard;
  const lookedChat = cwRuns.data?.lastLooked?.chat ?? null;
  const cwReady = cwRuns.isSuccess;
  const onChatVisible = useEffectEvent(() => {
    setChatSince(lookedChat);
    markLooked("chat");
  });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- snapshot the previous look once per visible visit
    if (chatVisible && cwReady) onChatVisible();
  }, [chatVisible, cwReady]);
  const sinceAt = chatSince ? Date.parse(chatSince) : NaN;
  const sinceCounts = Number.isFinite(sinceAt)
    ? {
        decisions: (cwDecisions.data?.decisions ?? []).filter((x) => Date.parse(x.createdAt) > sinceAt).length,
        ...sinceRunCounts(
          runRows.filter((r) => !r.parentRunId),
          sinceAt,
        ),
      }
    : { decisions: 0, runs: 0 };
  const openedRequest = useRef<string | null>(null);
  const openRequested = useEffectEvent((card: DynamicCard) => {
    show();
    setActiveCard(card);
  });
  useEffect(() => {
    if (!requestedCard || openedRequest.current === requestedCard) return;
    const card = dynamic.data?.cards.find((c) => c.id === requestedCard);
    if (card) {
      openedRequest.current = requestedCard;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a queued surface deep link explicitly opens its host after data arrives
      openRequested(card);
    }
  }, [requestedCard, dynamic.data]);
  const d = info.data?.area ? (info.data as CoordinatorResponse) : null;
  const inFlight = status.counts.working + status.counts.stuck + status.counts.waiting;
  const tabs: { id: Tab; label: string; count?: number; tone?: "bad" | "warn"; hint?: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "needs", label: "Needs you", count: needsCount, tone: needsCount ? "warn" : undefined, hint: `${needsCount} waiting on you` },
    {
      id: "running",
      label: "Activity",
      count: inFlight,
      tone: status.counts.newStuck ? "bad" : undefined,
      hint: `${status.counts.working} working, ${status.counts.stuck} stuck, ${status.counts.waiting} waiting on you`,
    },
  ];
  const content = (
    <>
      <header className="gc-head">
        <h2 id={`${ids}-title`}>Chief of staff</h2>
        {d && (!d.agent.routed || d.agent.profile !== d.agent.requested) ? <AgentChip agent={d.agent} prefix="Answers" /> : null}
        <Button
          data-gc-close
          variant="ghost"
          size="sm"
          iconOnly
          icon={wide ? <ChevronIcon className="h-4 w-4" /> : "×"}
          className="gc-close"
          aria-label={wide ? "Collapse Chief of staff" : "Close Chief of staff"}
          onClick={hide}
        >
          {wide ? "Collapse" : "Close"}
        </Button>
      </header>
      {line.card ? (
        <p className="gc-priority" data-tone={line.tone} data-dynamic={awayLine || undefined} role="status">
          {line.text}
          <Button variant="ghost" size="sm" onClick={showPriority}>
            {line.card.action}
          </Button>
        </p>
      ) : null}
      {activeCard ? (
        <DynamicSurface card={activeCard} onDismiss={dismissCard} />
      ) : (
        <>
          <div className="gc-tabs" role="tablist" aria-label="Chief of staff tabs">
            {tabs.map((t, index) => (
              <button
                type="button"
                role="tab"
                id={`${ids}-${t.id}`}
                aria-controls={`${ids}-panel-${t.id}`}
                aria-selected={tab === t.id}
                tabIndex={tab === t.id ? 0 : -1}
                key={t.id}
                onClick={() => selectTab(t.id)}
                onKeyDown={(e) => {
                  let next = index;
                  if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
                  else if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
                  else if (e.key === "Home") next = 0;
                  else if (e.key === "End") next = tabs.length - 1;
                  else return;
                  e.preventDefault();
                  selectTab(tabs[next]!.id);
                  document.getElementById(`${ids}-${tabs[next]!.id}`)?.focus();
                }}
              >
                {t.label}
                {t.count ? (
                  <span className="gc-badge" data-tone={t.tone} title={t.hint}>
                    {t.count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {info.error || error ? (
            <p role="alert" className="gc-error">
              Some of this couldn&apos;t load. Retrying automatically.
            </p>
          ) : null}
          {info.isLoading ? <p className="gc-empty">Loading…</p> : null}
          {info.isSuccess && !d ? (
            <div className="gc-empty">
              No Chief of staff yet: set an area&apos;s agent to chiefofstaff in <Link href="/settings/agents">Settings → Agents</Link>.
            </div>
          ) : null}
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`gc-panel-content ${t.id === "chat" ? "gc-chat" : ""}`}
              role="tabpanel"
              id={`${ids}-panel-${t.id}`}
              aria-labelledby={`${ids}-${t.id}`}
              hidden={tab !== t.id}
              tabIndex={0}
            >
              {t.id === "chat" ? (
                <div className="gc-away">
                  <WhileAwayCard compact />
                </div>
              ) : null}
              {t.id === "chat" && d ? (
                <CoordinatorThread
                  key={d.area.id}
                  info={d}
                  compact
                  name="Chief of staff"
                  draft={draft}
                  onDraft={setDraft}
                  context={attached}
                  contextRemoved={!!context && !attached}
                  onRemoveContext={() => setRemovedOn(pageKey)}
                  onRestoreContext={() => setRemovedOn(null)}
                  onAskPage={() => {
                    setRemovedOn(null);
                    prefill(ASK_PAGE);
                  }}
                  quickContext={quickContext}
                  inlineActions={(lastUserAt) => <ActionCards rows={things.changes.filter((a) => !lastUserAt || a.at > lastUserAt).slice(0, 3)} />}
                  lastLookedChat={chatSince}
                  sinceCounts={sinceCounts}
                  onJump={(next) => selectTab(next === "needs" ? "needs" : "running")}
                  onRef={onRef}
                />
              ) : null}
              {t.id === "needs" && tab === "needs" ? (
                <NeedsPanel
                  hasOther={otherAsks.length + stalledAsks.length > 0}
                  key={focusRef?.tab === "needs" ? `n${focusRef.n}` : "needs"}
                  initialRef={focusRef?.tab === "needs" ? focusRef.ref : undefined}
                  onAsk={(ref, question) => prefill(`About ${ref} (${question.slice(0, 160)}): `)}
                  lead={
                    otherAsks.length || stalledAsks.length ? (
                      <>
                        {otherAsks.length ? (
                          <section className="gc-list" aria-label="Approvals and proposals">
                            <SectionHeader label="Waiting for your approval" count={otherAsks.length} />
                            {otherAsks.map((ask) => (
                              <Link key={ask.key} href={ask.href}>
                                <strong>{ask.title}</strong>
                                <span>{ask.question} · opens the conversation</span>
                              </Link>
                            ))}
                          </section>
                        ) : null}
                        {stalledAsks.length ? (
                          <section className="gc-list" aria-label="Runs to check">
                            <Button variant="ghost" className="gc-stalled-row" onClick={() => selectTab("running")}>
                              <strong>{stalledAsks.length === 1 ? "1 run has" : `${stalledAsks.length} runs have`} not reported for over 30 minutes</strong>
                              <span>Counted here as on Today · check them in Activity</span>
                            </Button>
                          </section>
                        ) : null}
                      </>
                    ) : null
                  }
                />
              ) : null}
              {t.id === "running" && things.changes.length ? (
                <p className="gc-jump">
                  <Button variant="ghost" size="sm" onClick={() => document.getElementById(`${ids}-changes`)?.scrollIntoView({ block: "start" })}>
                    {things.changes.length === 1 ? "1 change" : `${things.changes.length} changes`} by the Chief of staff in the last 24 hours
                  </Button>
                </p>
              ) : null}
              {t.id === "running" && tab === "running" ? (
                <RunningPanel
                  key={focusRef?.tab === "running" ? `r${focusRef.n}` : "running"}
                  initialRef={focusRef?.tab === "running" ? focusRef.ref : undefined}
                  onSteer={(ref, title) => prefill(`Steer ${ref} (${title.slice(0, 120)}): `)}
                  onCommand={prefill}
                  quietEmpty={otherRuns.length > 0 || things.changes.length > 0}
                />
              ) : null}
              {t.id === "running" && tab === "running" && otherRuns.length ? (
                <section className="gc-list" aria-label="Jobs and checks">
                  <SectionHeader label={cwRuns.isError ? "Saved item status · live details unavailable" : "Jobs and checks"} count={otherRuns.length} />
                  {otherRuns.map((run) => (
                    <Link key={run.id} href={`/areas?item=${encodeURIComponent(run.itemId)}`}>
                      <strong>{run.title}</strong>
                      <span data-tone={run.state === "failed" || run.state === "stalled" ? "bad" : "ai"}>
                        {OTHER_STATE[run.state]}
                        {run.at ? ` · ${relativeTime(run.at)}` : ""}
                      </span>
                    </Link>
                  ))}
                </section>
              ) : null}
              {t.id === "running" ? <ChangesSection id={`${ids}-changes`} rows={things.changes} /> : null}
            </div>
          ))}
        </>
      )}
    </>
  );
  const statusId = `${ids}-status`;
  return (
    <div ref={host} className="gc-host">
      {wide ? (
        <aside
          aria-label="Chief of staff"
          className={`gc-rail ${expanded ? "" : "gc-strip"}`}
          style={{ width: railWidth } as CSSProperties}
          data-testid="gc-rail"
          data-open={expanded}
          onKeyDown={onPanelKey}
        >
          {expanded ? (
            <>
              <div
                className="gc-resizer"
                role="separator"
                aria-label="Resize Chief of staff"
                aria-orientation="vertical"
                aria-valuemin={300}
                aria-valuemax={520}
                aria-valuenow={width}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    saveWidth(width + (e.key === "ArrowLeft" ? 20 : -20));
                  }
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) saveWidth(window.innerWidth - e.clientX);
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                }}
              />
              {content}
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                className="gc-strip-btn gc-expand"
                aria-label="Expand Chief of staff"
                title={`Chief of staff · ${tray.text}`}
                onClick={show}
              >
                <span className="gc-orb" aria-hidden="true" />
                <AttentionDot dot={tray.dot} />
              </Button>
              {tabs.slice(1).map((t) => (
                <Button
                  variant="ghost"
                  className="gc-strip-btn"
                  key={t.id}
                  aria-label={`${t.label}${t.count ? `, ${t.count}` : ""}`}
                  title={t.count ? `${t.label} · ${t.hint}` : t.label}
                  onClick={() => {
                    show();
                    selectTab(t.id);
                  }}
                >
                  {t.id === "needs" ? <InboxIcon className="h-4 w-4" /> : <BoltIcon className="h-4 w-4" />}
                  {t.count ? (
                    <span className="gc-badge" data-tone={t.tone}>
                      {t.count}
                    </span>
                  ) : null}
                </Button>
              ))}
            </>
          )}
        </aside>
      ) : (
        <>
          {!chat && d ? (
            <div className="gc-tray-qa" data-testid="gc-tray-quick-actions">
              <QuickActionChips
                variant="tray"
                context={quickContext}
                onPrompt={(value) => {
                  show();
                  setTab("chat");
                  setDraft(value.slice(0, 8000));
                }}
              />
            </div>
          ) : null}
          {!chat ? (
            <div className="gc-tray" data-state={tray.state} data-dynamic-tone={line.card?.line.tone}>
              <button
                type="button"
                className="gc-tray-main"
                aria-label="Chief of staff"
                aria-describedby={statusId}
                aria-haspopup="dialog"
                onClick={showPriority}
              >
                <span className="gc-tray-avatar">
                  <span className="gc-orb" aria-hidden="true" />
                  <AttentionDot dot={tray.dot} />
                </span>
                <span className="gc-tray-copy">
                  <strong>
                    {line.card ? (
                      <>
                        <span aria-hidden="true">{line.card.line.icon} </span>
                        {line.card.line.label}
                      </>
                    ) : (
                      "Chief of staff"
                    )}
                  </strong>
                  <span id={statusId} className="gc-tray-status" data-dynamic>
                    <span data-tone={tray.tone === "neutral" ? undefined : tray.tone}>{tray.text}</span>
                    {tray.rest ? <span className="gc-tray-rest"> · {tray.rest}</span> : null}
                  </span>
                </span>
                {line.card ? <span className="gc-tray-action">{line.card.action}</span> : null}
                <ChevronIcon className="gc-tray-chevron h-4 w-4" />
              </button>
            </div>
          ) : null}
          {phoneOpen ? (
            <dialog
              ref={dialog}
              className="gc-sheet"
              aria-modal="true"
              aria-labelledby={`${ids}-title`}
              onCancel={() => setPhoneOpen(false)}
              onKeyDown={onPanelKey}
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  const r = e.currentTarget.getBoundingClientRect();
                  if (e.clientY < r.top) setPhoneOpen(false);
                }
              }}
            >
              {content}
              <div data-quick-action-notices className="shrink-0" />
            </dialog>
          ) : null}
        </>
      )}
    </div>
  );
}

const OTHER_STATE: Record<"running" | "stalled" | "failed" | "waiting", string> = {
  running: "Working",
  stalled: "No update for a while",
  failed: "Failed",
  waiting: "Waiting",
};

function AttentionDot({ dot }: { dot: "red" | "yellow" | null }) {
  return dot ? <span className="gc-dot" data-dot={dot} role="img" aria-label={dot === "red" ? "Attention required" : "Updates to review"} /> : null;
}

function actionLabel(row: ActivityItem) {
  if (row.type === "created") return "Created item";
  if (/needs your decision/i.test(row.verb)) return "Raised decision";
  if (/started.*run/i.test(row.verb)) return "Started agent run";
  if (/finished.*run|run.*(done|finished)/i.test(row.verb)) return "Finished agent run";
  return row.verb.charAt(0).toUpperCase() + row.verb.slice(1);
}
function ActionCards({ rows }: { rows: ActivityItem[] }) {
  return (
    <div className="gc-action-list">
      {rows.map((row) => (
        <ActionCard key={row.id} row={row} />
      ))}
    </div>
  );
}
function UndoButton({ row }: { row: ActivityItem }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [undone, setUndone] = useState(false);
  const undo = async () => {
    if (!row.undoOpId || pending) return;
    setPending(true);
    try {
      await api.post(`/api/work/ops/${encodeURIComponent(row.undoOpId)}/undo`);
      setUndone(true);
      toast("Undone");
      await Promise.all([qc.invalidateQueries({ queryKey: ["work"] }), qc.invalidateQueries({ queryKey: ["activity"] })]);
    } catch (err) {
      toast(`Not undone: ${(err as Error).message}`, "danger");
    } finally {
      setPending(false);
    }
  };
  return row.undoOpId ? (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending || undone}
      onClick={() => void undo()}
      aria-label={`Undo ${actionLabel(row)}${row.object ? `: ${row.object.title}` : ""}`}
    >
      {undone ? "Undone" : "Undo"}
    </Button>
  ) : null;
}
function ActionCard({ row }: { row: ActivityItem }) {
  return (
    <article className="gc-action">
      <span className="gc-action-icon" aria-hidden="true">
        {row.type === "created" ? "+" : row.type === "chat" ? "↻" : "✦"}
      </span>
      <div>
        <strong>{actionLabel(row)}</strong>
        {row.object ? <Link href={`/areas?item=${encodeURIComponent(row.object.id)}`}>{row.object.title}</Link> : null}
        <span className="gc-hint">{relativeTime(row.at)}</span>
      </div>
      <UndoButton row={row} />
    </article>
  );
}

const CHANGES_SHOWN = 5;
/** What the Chief of staff changed in the last day, grouped by item so three edits to one item read as one entry. */
function ChangesSection({ rows, id }: { rows: ActivityItem[]; id?: string }) {
  const [all, setAll] = useState(false);
  const groups: { key: string; object: ActivityItem["object"]; rows: ActivityItem[] }[] = [];
  for (const row of rows) {
    const key = row.object?.id ?? `row:${row.id}`;
    const group = groups.find((g) => g.key === key);
    if (group) group.rows.push(row);
    else groups.push({ key, object: row.object, rows: [row] });
  }
  const shown = all ? groups : groups.slice(0, CHANGES_SHOWN);
  return (
    <section id={id} className="gc-changes" aria-label="Changes">
      <SectionHeader
        label={`Changes on ${groups.length === 1 ? "1 item" : `${groups.length} items`} · last 24 hours`}
        count={rows.length}
        action={
          groups.length > CHANGES_SHOWN ? (
            <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `All ${groups.length} items`}
            </Button>
          ) : undefined
        }
      />
      {!rows.length ? <p className="gc-hint">Nothing changed by the Chief of staff in the last day.</p> : null}
      <ul className="gc-change-groups">
        {shown.map((group) => (
          <li key={group.key} className="gc-change-group">
            {group.object ? (
              <Link className="gc-change-title" href={`/areas?item=${encodeURIComponent(group.object.id)}`}>
                {group.object.title}
              </Link>
            ) : null}
            <ul>
              {group.rows.map((row) => (
                <li key={row.id} className="gc-change-row">
                  <span className="min-w-0 flex-1">
                    {actionLabel(row)}
                    <span className="gc-hint"> · {relativeTime(row.at)}</span>
                  </span>
                  <UndoButton row={row} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
