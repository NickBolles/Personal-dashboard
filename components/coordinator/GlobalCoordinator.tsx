"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { ActivityItem } from "@/lib/activity";
import type { ItemsResponse, WorkItem } from "@/lib/work";
import { relativeTime } from "@/lib/time";
import { pageContext } from "@/lib/coordinator/page-context";
import { sessionIdFromRoute } from "@/lib/composer-target";
import { usePanelOwner } from "@/lib/client/panel-owner";
import { AgentChip } from "@/components/agents/AgentChip";
import { useToast } from "@/components/ui";
import { OPEN_COORDINATOR_EVENT, OPEN_PALETTE_EVENT } from "@/components/navigation/commands";
import { CoordinatorThread, type CoordinatorResponse } from "./CoordinatorThread";
import { QuickActionChips } from "@/components/quick-actions/QuickActionChips";
import { COORDINATOR_PROMPT, QUICK_ACTION_MANAGE, type QuickActionContext } from "@/lib/quick-actions";
import { useCoordinatorThings } from "./useCoordinatorThings";
import { pickTrayLine } from "@/lib/coordinator/things";
import type { DynamicCard, DynamicResponse } from "@/lib/jarvis-ui/dynamic";
import { useSmartSettings } from "@/components/smart/AssistantText";
import { DynamicSurface } from "@/components/smart/DynamicSurface";
import "./coordinator.css";

const clamp = (width: number) => Math.min(520, Math.max(300, width));
const subscribeWide = (cb: () => void) => {
  const m = window.matchMedia("(min-width: 900px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const getWide = () => window.matchMedia("(min-width: 900px)").matches;
type Tab = "chat" | "needs" | "running" | "changes" | "page";

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
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const { things, line: priority, markSeen, error } = useCoordinatorThings();
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
  const line = pickTrayLine(priority, dynamic.data?.cards ?? [], snoozed);
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
    saveOpen(true);
    setChatExpandedOn(pageKey);
    setPhoneOpen(true);
  };
  const showPriority = () => {
    setActiveCard(line.card);
    show();
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
    if (line.dot) shell?.setAttribute("data-gc-dot", line.dot);
    else shell?.removeAttribute("data-gc-dot");
    return () => {
      shell?.style.removeProperty("--gc-w");
      shell?.removeAttribute("data-gc-dot");
    };
  }, [wide, railWidth, line.dot]);
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
  const openedRequest = useRef<string | null>(null);
  const openRequested = useEffectEvent((card: DynamicCard) => {
    setActiveCard(card);
    show();
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
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "chat", label: "Chat" },
    { id: "needs", label: "Needs you", count: things.needsYou },
    { id: "running", label: "Running", count: things.running.length },
    { id: "changes", label: "Changes", count: things.changes.length },
    { id: "page", label: "This page" },
  ];
  const content = (
    <>
      <header className="gc-head">
        <h2 id={`${ids}-title`}>Chief of staff</h2>
        <button data-gc-close type="button" className="gc-icon" aria-label={wide ? "Collapse Chief of staff" : "Close Chief of staff"} onClick={hide}>
          {wide ? "›" : "×"}
        </button>
        {d ? <AgentChip agent={d.agent} prefix="Answers" /> : null}
      </header>
      <p className="gc-priority" data-tone={line.tone} role="status">
        {line.text}
        {line.card ? (
          <button type="button" className="gc-icon" onClick={showPriority}>
            {line.card.action}
          </button>
        ) : null}
      </p>
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
                onClick={() => {
                  setTab(t.id);
                  if (t.id === "changes" || t.id === "running") markSeen();
                }}
                onKeyDown={(e) => {
                  let next = index;
                  if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
                  else if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
                  else if (e.key === "Home") next = 0;
                  else if (e.key === "End") next = tabs.length - 1;
                  else return;
                  e.preventDefault();
                  setTab(tabs[next]!.id);
                  document.getElementById(`${ids}-${tabs[next]!.id}`)?.focus();
                }}
              >
                {t.label}
                {t.count !== undefined ? <span className="gc-badge">{t.count}</span> : null}
              </button>
            ))}
          </div>
          {info.error || error ? (
            <p role="alert" className="gc-error">
              Some coordinator data couldn&apos;t load. It will retry automatically.
            </p>
          ) : null}
          {info.isLoading ? <p className="gc-empty">Loading Chief of staff…</p> : null}
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
              {t.id === "chat" && d ? (
                <CoordinatorThread
                  key={d.area.id}
                  info={d}
                  compact
                  draft={draft}
                  onDraft={setDraft}
                  context={attached}
                  onRemoveContext={() => setRemovedOn(pageKey)}
                  quickContext={quickContext}
                  inlineActions={(lastUserAt) => <ActionCards rows={things.changes.filter((a) => !lastUserAt || a.at > lastUserAt).slice(0, 3)} />}
                />
              ) : null}
              {t.id === "needs" ? (
                <div className="gc-list">
                  {things.decisions.length ? (
                    things.decisions.map((decision) => (
                      <Link key={decision.key} href={decision.href}>
                        <strong>{decision.title}</strong>
                        <span>{decision.question}</span>
                      </Link>
                    ))
                  ) : (
                    <p>Nothing needs you right now.</p>
                  )}
                </div>
              ) : null}
              {t.id === "running" ? (
                <div className="gc-list">
                  {[...things.running, ...things.failing.filter((f) => !things.running.some((r) => r.id === f.id))].map((run) => (
                    <Link key={run.id} href={`/areas?item=${encodeURIComponent(run.itemId)}`}>
                      <strong>{run.title}</strong>
                      <span data-tone={run.state === "failed" || run.state === "stalled" ? "bad" : "ai"}>
                        {run.state}
                        {run.at ? ` · ${relativeTime(run.at)}` : ""}
                      </span>
                    </Link>
                  ))}
                  {!things.running.length && !things.failing.length ? <p>No active runs.</p> : null}
                </div>
              ) : null}
              {t.id === "changes" ? (
                <div className="gc-changes">
                  <p className="gc-hint">By @chiefofstaff · last 24 hours</p>
                  <ActionCards rows={things.changes} />
                  {!things.changes.length ? <p>No recent changes.</p> : null}
                </div>
              ) : null}
              {t.id === "page" ? (
                <div className="gc-page">
                  {context ? (
                    <>
                      <p>Viewing: {context.label}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft("Help me understand this page and suggest the next action.");
                          setRemovedOn(null);
                          setTab("chat");
                        }}
                      >
                        Ask about this page
                      </button>
                    </>
                  ) : (
                    <p>No page context is shared.</p>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </>
      )}
    </>
  );
  return (
    <div ref={host} className="gc-host">
      {wide ? (
        <aside
          aria-label="Chief of staff"
          className={`gc-rail ${expanded ? "" : "gc-strip"}`}
          style={{ width: railWidth } as CSSProperties}
          data-testid="gc-rail"
          data-open={expanded}
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
              <button type="button" className="gc-icon gc-expand" aria-label="Expand Chief of staff" onClick={show}>
                <span className="gc-orb" aria-hidden="true" />
                <AttentionDot dot={line.dot} />
              </button>
              {tabs.slice(1, 4).map((t) => (
                <button
                  type="button"
                  className="gc-icon"
                  key={t.id}
                  aria-label={`${t.label}${t.count ? `, ${t.count}` : ""}`}
                  onClick={() => {
                    show();
                    setTab(t.id);
                  }}
                >
                  <span aria-hidden="true">{t.id === "needs" ? "!" : t.id === "running" ? "↻" : "≡"}</span>
                  {t.count ? <span className="gc-badge">{t.count}</span> : null}
                </button>
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
            <button
              type="button"
              className="gc-tray"
              data-state={line.state}
              data-dynamic-tone={line.card?.line.tone}
              aria-label="Chief of staff"
              aria-haspopup="dialog"
              onClick={showPriority}
            >
              <span className="gc-tray-avatar">
                <span className="gc-orb" aria-hidden="true" />
                <span className="gc-tray-phone hidden">
                  <AttentionDot dot={line.dot} />
                </span>
              </span>
              <span className="gc-tray-copy">
                <strong>
                  {!line.card ? (
                    <span className="gc-tray-phone hidden" data-tone={line.tone}>
                      {line.state === "failing"
                        ? "Failing"
                        : line.state === "needs"
                          ? "Needs you"
                          : line.state === "done"
                            ? "Finished"
                            : line.state === "running"
                              ? "Running"
                              : "Quiet"}{" "}
                      ·{" "}
                    </span>
                  ) : null}
                  {line.card ? (
                    <>
                      <span aria-hidden="true">{line.card.line.icon} </span>
                      {line.card.line.label}
                    </>
                  ) : (
                    "Chief of staff"
                  )}
                </strong>
                <span className="gc-priority" data-tone={line.tone}>
                  {line.card ? line.card.line.text : line.text}
                </span>
              </span>
              {line.card ? <span className="shrink-0 text-xs text-accent">{line.card.action}</span> : null}
              <span className="gc-tray-counts hidden">
                {things.needsYou ? (
                  <span data-tone="warn" aria-label={`${things.needsYou} need you`}>
                    <span aria-hidden="true">⛨</span> {things.needsYou}
                  </span>
                ) : null}
                {things.running.length ? (
                  <span data-tone="ai" aria-label={`${things.running.length} running`}>
                    <span className="inline-block motion-safe:animate-spin" aria-hidden>
                      ↻
                    </span>{" "}
                    {things.running.length}
                  </span>
                ) : null}
                {things.failing.length ? (
                  <span data-tone="bad" aria-label={`${things.failing.length} failing`}>
                    × {things.failing.length}
                  </span>
                ) : null}
              </span>
              <span className="gc-tray-tablet-dot">
                <AttentionDot dot={line.dot} />
              </span>
              <span className="gc-tray-phone hidden" aria-hidden="true">
                ⌃
              </span>
            </button>
          ) : null}
          {phoneOpen ? (
            <dialog
              ref={dialog}
              className="gc-sheet"
              aria-modal="true"
              aria-labelledby={`${ids}-title`}
              onCancel={() => setPhoneOpen(false)}
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

function AttentionDot({ dot }: { dot: "red" | "yellow" | null }) {
  return dot ? <span className="gc-dot" data-dot={dot} aria-label={dot === "red" ? "Attention required" : "Updates to review"} /> : null;
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
function ActionCard({ row }: { row: ActivityItem }) {
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
  return (
    <article className="gc-action">
      <span className="gc-action-icon" aria-hidden="true">
        {row.type === "created" ? "+" : row.type === "chat" ? "↻" : "✦"}
      </span>
      <div>
        <strong>{actionLabel(row)}</strong>
        {row.object ? <Link href={`/areas?item=${encodeURIComponent(row.object.id)}`}>{row.object.title}</Link> : null}
        <span className="gc-hint">{relativeTime(row.at)} · @chiefofstaff</span>
      </div>
      {row.undoOpId ? (
        <button
          type="button"
          disabled={pending || undone}
          onClick={() => void undo()}
          aria-label={`Undo ${actionLabel(row)}${row.object ? `: ${row.object.title}` : ""}`}
        >
          {undone ? "Undone" : "Undo"}
        </button>
      ) : null}
    </article>
  );
}
