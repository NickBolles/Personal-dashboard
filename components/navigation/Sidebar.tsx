"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, ErrorNote, Spinner } from "@/components/ui";
import { BellIcon, ChatIcon, GearIcon, InboxIcon, PanelIcon, SearchIcon, SunIcon } from "@/components/icons";
import { WorkTree } from "@/components/work/WorkTree";
import { useWorkMutation } from "@/components/work/common";
import { useInbox } from "@/components/work/today";
import { OPEN_SEARCH_EVENT } from "@/components/search/SearchDialog";
import { shortcutLabel, useModKey } from "@/lib/client/platform";
import type { ItemsResponse, WorkItem } from "@/lib/work";

export const SIDEBAR_COLLAPSED_KEY = "jarvis.sidebar.collapsed";
const PINS_KEY = "jarvis.sidebar.pins";
const PIN_MIME = "application/x-jarvis-area";

function readPins(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(PINS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 24) : [];
  } catch {
    return [];
  }
}

function savePins(pins: string[]) {
  try {
    window.localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
}

/** Collapsed state of the desktop sidebar, remembered per browser. */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount (SSR has no storage)
    setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  return [collapsed, toggle] as const;
}

type Entry = { key: string; href: string; label: string; icon: (p: { className?: string }) => React.ReactNode; active: boolean; badge?: number };

/**
 * Desktop (≥1024) left sidebar, Arc-style (design review D1, G1): search/command,
 * Today · Inbox · Chat · Alerts, pinned areas (drag an area onto Pinned to pin,
 * drag pins to reorder), the live Areas tree, Settings. Collapses to an icon rail.
 * Tablet/phone keep the top row / bottom bar.
 */
export function Sidebar({
  collapsed,
  onToggle,
  unread,
  canWork,
  canChat,
}: {
  collapsed: boolean;
  onToggle: () => void;
  unread: number;
  canWork: boolean;
  canChat: boolean;
}) {
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const mod = useModKey();
  const items = useQuery({
    queryKey: ["work", "items", false],
    queryFn: () => api.get<ItemsResponse>("/api/work/items"),
    enabled: canWork,
  });
  const inbox = useInbox();
  const place = useWorkMutation((v: { id: string; parentId: string | null; index: number }) =>
    api.post(`/api/work/items/${encodeURIComponent(v.id)}/place`, { parentId: v.parentId, index: v.index }),
  );
  const [pins, setPins] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount
    setPins(readPins());
  }, []);
  const updatePins = (next: string[]) => {
    setPins(next);
    savePins(next);
  };

  const list = items.data?.items ?? [];
  const byId = new Map(list.map((i) => [i.id, i]));
  const areas = list.filter((i) => i.kind === "area" && !i.archived);
  const pinned = pins.map((id) => byId.get(id)).filter((i): i is WorkItem => !!i);
  const selectedItem = path.startsWith("/areas") ? params.get("item") : null;
  const sessionId = path.startsWith("/chat/") ? decodeURIComponent(path.slice(6)) : null;
  const view = path.startsWith("/areas") ? params.get("view") : null;

  const entries: Entry[] = [
    { key: "home", href: "/home", label: "Today", icon: SunIcon, active: path === "/home" || path === "/" },
    ...(canWork ? [{ key: "inbox", href: "/areas?view=inbox", label: "Inbox", icon: InboxIcon, active: view === "inbox", badge: inbox.data?.count ?? 0 }] : []),
    ...(canChat ? [{ key: "chat", href: "/chat", label: "Chat", icon: ChatIcon, active: path === "/chat" }] : []),
    { key: "alerts", href: "/alerts", label: "Alerts", icon: BellIcon, active: path.startsWith("/alerts"), badge: unread },
  ];

  const onDropPin = (e: DragEvent, beforeId: string | null) => {
    const id = e.dataTransfer.getData(PIN_MIME);
    setDropping(false);
    if (!id) return;
    e.preventDefault();
    const rest = pins.filter((p) => p !== id);
    const at = beforeId ? rest.indexOf(beforeId) : -1;
    updatePins(at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]);
  };
  const dragStart = (id: string) => (e: DragEvent) => {
    e.dataTransfer.setData(PIN_MIME, id);
    e.dataTransfer.effectAllowed = "move";
  };

  const rowCls = (active: boolean) =>
    cx(
      "relative flex min-h-11 items-center gap-2.5 rounded-[8px] px-2.5 text-[0.875rem]",
      collapsed && "justify-center px-0",
      active ? "bg-surface-2 font-semibold text-text" : "text-muted hover:bg-surface-2 hover:text-text",
    );

  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed ? "true" : undefined}
      className="jv-sidebar fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-line bg-surface lg:flex"
    >
      <div className={cx("flex h-11 items-center gap-1 px-2", collapsed && "justify-center")}>
        {!collapsed ? (
          <Link href="/home" aria-label="Jarvis home" className="flex min-h-11 flex-1 items-center gap-2 px-1.5 text-[0.9375rem] font-bold">
            <span aria-hidden="true" className="brand-mark" />
            <span>Jarvis</span>
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-text"
        >
          <PanelIcon className="h-[18px] w-[18px]" />
        </button>
      </div>
      <nav aria-label="Sidebar" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
          aria-label={`Search or command (${shortcutLabel(mod, "K")})`}
          className={cx(
            "flex min-h-11 items-center gap-2 rounded-[8px] border border-line px-2.5 text-left text-[0.8125rem] text-muted hover:border-line-strong hover:text-text",
            collapsed && "justify-center px-0",
          )}
        >
          <SearchIcon className="h-4 w-4 shrink-0" />
          {!collapsed ? (
            <>
              <span className="flex-1">Search or command</span>
              <kbd className="text-[11px]">{shortcutLabel(mod, "K")}</kbd>
            </>
          ) : null}
        </button>
        <ul className="space-y-0.5">
          {entries.map((d) => {
            const Icon = d.icon;
            return (
              <li key={d.key}>
                <Link
                  href={d.href}
                  aria-current={d.active ? "page" : undefined}
                  aria-label={d.badge ? `${d.label}, ${d.badge} ${d.key === "alerts" ? "unread" : "waiting"}` : d.label}
                  title={collapsed ? d.label : undefined}
                  className={rowCls(d.active)}
                >
                  <Icon className={cx("h-[18px] w-[18px] shrink-0", d.active && "text-accent")} />
                  {!collapsed ? <span className="flex-1 truncate">{d.label}</span> : null}
                  {d.badge ? (
                    <span
                      aria-hidden="true"
                      data-dynamic
                      className={cx(
                        "rounded-full px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums",
                        d.key === "alerts" ? "bg-danger text-white dark:text-black" : "bg-warn-soft text-warn",
                        collapsed && "absolute top-1 right-1 px-1 text-[10px] leading-[14px]",
                      )}
                    >
                      {d.badge > 99 ? "99+" : d.badge}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>

        {canWork ? (
          <section
            aria-label="Pinned areas"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PIN_MIME)) return;
              e.preventDefault();
              setDropping(true);
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => onDropPin(e, null)}
            className={cx("rounded-[10px]", dropping && "ring-2 ring-accent/50")}
          >
            {!collapsed ? <h2 className="wk-label px-1 pb-1">Pinned</h2> : null}
            {pinned.length === 0 && !collapsed ? (
              <p className="px-1 text-[12px] text-muted">Drag an area here to pin it.</p>
            ) : (
              <ul className={cx("grid gap-1", collapsed ? "grid-cols-1" : "grid-cols-2")}>
                {pinned.map((a) => {
                  const active = selectedItem === a.id;
                  return (
                    <li
                      key={a.id}
                      draggable
                      onDragStart={dragStart(a.id)}
                      onDragOver={(e) => e.dataTransfer.types.includes(PIN_MIME) && e.preventDefault()}
                      onDrop={(e) => {
                        e.stopPropagation();
                        onDropPin(e, a.id);
                      }}
                      className="group relative"
                    >
                      <Link
                        href={`/areas?item=${encodeURIComponent(a.id)}`}
                        aria-current={active ? "page" : undefined}
                        title={a.title}
                        className={cx(
                          "flex min-h-11 items-center justify-center rounded-[10px] border px-2 text-center text-[0.8125rem] font-medium",
                          active ? "border-accent bg-accent/10 text-text" : "border-line bg-surface-2 text-text hover:border-line-strong",
                        )}
                      >
                        <span className={cx("truncate", collapsed && "sr-only")}>{a.title}</span>
                        {collapsed ? (
                          <span aria-hidden="true" className="font-semibold">
                            {a.title.slice(0, 1).toUpperCase()}
                          </span>
                        ) : null}
                      </Link>
                      {!collapsed ? (
                        <button
                          type="button"
                          onClick={() => updatePins(pins.filter((p) => p !== a.id))}
                          aria-label={`Unpin ${a.title}`}
                          className="absolute -top-1.5 -right-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-[11px] text-muted group-focus-within:flex group-hover:flex"
                        >
                          ×
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {canWork && !collapsed ? (
          <section aria-label="Areas" className="min-h-0">
            <div className="flex items-center justify-between px-1 pb-1">
              <h2 className="wk-label">Areas</h2>
              <Link href="/areas" className="text-[12px] text-muted hover:text-text">
                All
              </Link>
            </div>
            {/* Top-level areas are draggable onto Pinned; the tree below keeps its own pointer drag for re-parenting. */}
            {areas.length ? (
              <ul className="mb-1 flex flex-wrap gap-1 px-1" aria-label="Areas you can pin">
                {areas
                  .filter((a) => !pins.includes(a.id))
                  .map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        draggable
                        onDragStart={dragStart(a.id)}
                        onClick={() => updatePins([...pins, a.id])}
                        aria-label={`Pin ${a.title}`}
                        title="Click or drag to Pinned"
                        className="rounded-full border border-dashed border-line px-2 py-0.5 text-[11.5px] text-muted hover:border-line-strong hover:text-text"
                      >
                        + {a.title}
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
            {items.error ? <ErrorNote error={items.error} retry={() => items.refetch()} /> : null}
            {items.isPending ? (
              <Spinner label="Loading areas…" />
            ) : (
              <WorkTree
                items={list}
                linked={items.data?.linkedConversations}
                selected={selectedItem}
                selectedSession={sessionId}
                onSelect={(id) => router.push(`/areas?item=${encodeURIComponent(id)}`)}
                onOpenConversation={(sid) => router.push(`/chat/${encodeURIComponent(sid)}`)}
                onPlace={(id, parentId, index) => place.mutate({ id, parentId, index })}
              />
            )}
          </section>
        ) : null}
      </nav>
      <div className="border-t border-line p-2">
        <Link href="/settings" aria-current={path.startsWith("/settings") ? "page" : undefined} className={rowCls(path.startsWith("/settings"))}>
          <GearIcon className="h-[18px] w-[18px] shrink-0" />
          {!collapsed ? <span>Settings</span> : <span className="sr-only">Settings</span>}
        </Link>
      </div>
    </aside>
  );
}
