"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, useOnline } from "@/components/ui";
import { GearIcon, MoreIcon, PanelIcon, SearchIcon } from "@/components/icons";
import { useAccess } from "@/components/access";
import { OPEN_SEARCH_EVENT, SearchDialog } from "@/components/search/SearchDialog";
import { allowed, DESTINATIONS, PRIMARY, type Dest } from "./destinations";
import { CommandDock } from "./CommandDock";
import { NEW_CHAT_EVENT, OPEN_CAPTURE_EVENT } from "./commands";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { CaptureDialog } from "@/components/work/inbox";

const MORE: Dest = {
  key: "more",
  href: "/more",
  label: "More",
  icon: MoreIcon,
  match: (p) => p === "/more" || DESTINATIONS.some((d) => d.match(p)) || p.startsWith("/settings"),
};

const SETTINGS: Dest = { key: "settings", href: "/settings", label: "Settings", icon: GearIcon, match: (p) => p.startsWith("/settings") };

function destFor(path: string) {
  return [...PRIMARY, SETTINGS, ...DESTINATIONS].find((d) => d.match(path));
}

/** Remember the last sub-view per destination and scroll position per path. */
function useNavMemory(pathname: string) {
  const [memory, setMemory] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      setMemory(JSON.parse(sessionStorage.getItem("jarvis:navmem") ?? "{}"));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    const d = destFor(pathname);
    if (!d) return;
    const full = pathname + window.location.search;
    setMemory((m) => {
      const next = { ...m, [d.key]: full };
      try {
        sessionStorage.setItem("jarvis:navmem", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    const saved = Number(sessionStorage.getItem(`jarvis:scroll:${pathname}`) ?? 0);
    if (saved && !pathname.startsWith("/chat/")) requestAnimationFrame(() => window.scrollTo(0, saved));
    const onScroll = () => sessionStorage.setItem(`jarvis:scroll:${pathname}`, String(window.scrollY));
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [pathname]);
  return (d: Dest) => {
    const m = memory[d.key];
    // Tapping the active destination returns to its root.
    return m && !d.match(pathname) ? m : d.href;
  };
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "count"],
    queryFn: () => api.get<{ unread: number }>("/api/notifications/count"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

/*
 * Rail state: one global state everywhere (design review D3), so moving
 * between Home and Areas never shifts the layout. Default: the icon rail up
 * to 1440px wide, expanded above; the person's explicit choice ("jarvis:rail")
 * wins and is remembered.
 */
const RAIL_EVENT = "jarvis:rail-change";
const WIDE_RAIL = "(min-width: 1441px)";
function subscribeRail(cb: () => void) {
  const m = window.matchMedia(WIDE_RAIL);
  m.addEventListener("change", cb);
  window.addEventListener(RAIL_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    m.removeEventListener("change", cb);
    window.removeEventListener(RAIL_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
function readPref(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function useRail() {
  const wide = useSyncExternalStore(
    subscribeRail,
    () => window.matchMedia(WIDE_RAIL).matches,
    () => false,
  );
  const pref = useSyncExternalStore(
    subscribeRail,
    () => readPref("jarvis:rail"),
    () => null,
  );
  const collapsed = pref === "collapsed" || (pref !== "expanded" && !wide);
  const toggle = () => {
    try {
      localStorage.setItem("jarvis:rail", collapsed ? "expanded" : "collapsed");
    } catch {
      /* private mode: no memory */
    }
    window.dispatchEvent(new Event(RAIL_EVENT));
  };
  return { collapsed, toggle };
}

export function AppShell({ children, userName }: { children: ReactNode; userName: string }) {
  const pathname = usePathname();
  const hrefFor = useNavMemory(pathname);
  const online = useOnline();
  const unread = useUnreadCount().data?.unread ?? 0;
  const { collapsed, toggle: toggleRail } = useRail();
  const mainRef = useRef<HTMLElement>(null);
  const { capabilities } = useAccess();
  const primary = PRIMARY.filter((d) => allowed(d, capabilities));
  const destinations = DESTINATIONS.filter((d) => allowed(d, capabilities));
  // The phone bar holds four destinations around the orb; Hermes-only people (no Areas) keep Chat.
  const barItems = primary.filter((d) => d.key !== "chat" || !primary.some((p) => p.key === "areas")).slice(0, 3);
  const [searchOpen, setSearchOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const canWork = capabilities.includes("work.use");
  const newChat = useAskHermes();
  const startChat = useRef(newChat.start);
  useEffect(() => {
    startChat.current = newChat.start;
  });
  useEffect(() => {
    const onCapture = () => setCapturing(true);
    const onNewChat = (e: Event) => void startChat.current({ areaId: (e as CustomEvent<{ areaId?: string | null }>).detail?.areaId ?? null });
    window.addEventListener(OPEN_CAPTURE_EVENT, onCapture);
    window.addEventListener(NEW_CHAT_EVENT, onNewChat);
    return () => {
      window.removeEventListener(OPEN_CAPTURE_EVENT, onCapture);
      window.removeEventListener(NEW_CHAT_EVENT, onNewChat);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "/" && !(e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true]")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    const onOpen = () => setSearchOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    // ?search=1 opens search (the Android app's search shortcut; there's no /search page).
    const url = new URL(window.location.href);
    if (url.searchParams.get("search") === "1") {
      url.searchParams.delete("search");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
    };
  }, []);

  const badge =
    unread > 0 ? (
      <span
        aria-hidden="true"
        data-dynamic
        className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[10px] leading-[18px] font-semibold text-white dark:text-black"
      >
        {unread > 99 ? "99+" : unread}
      </span>
    ) : null;
  const badgeLabel = unread > 0 ? `, ${unread} unread` : "";

  // Rail rows keep a 44px hit area (touch laptops; e2e a11y contract) but read as compact rows.
  const railItem = (d: Dest) => {
    const active = d.match(pathname);
    const Icon = d.icon;
    return (
      <li key={d.key}>
        <Link
          href={hrefFor(d)}
          aria-current={active ? "page" : undefined}
          aria-label={d.key === "alerts" ? `Alerts${badgeLabel}` : undefined}
          title={collapsed ? d.label : undefined}
          className={cx(
            "group relative flex min-h-11 items-center gap-2.5 rounded-[8px] px-2.5 text-[0.875rem]",
            active ? "bg-surface font-semibold text-text shadow-[var(--shadow)] ring-1 ring-line" : "text-muted hover:bg-surface hover:text-text",
            collapsed && "justify-center px-0",
          )}
        >
          <span className="relative">
            <Icon className={cx("h-[18px] w-[18px]", active ? "text-accent" : "")} />
            {d.key === "alerts" && collapsed ? badge : null}
          </span>
          <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}>
            {d.label}
            {d.key === "alerts" ? <span className="sr-only">{badgeLabel}</span> : null}
          </span>
          {d.key === "alerts" && !collapsed && unread > 0 ? (
            <span aria-hidden="true" data-dynamic className="rounded-full bg-warn-soft px-1.5 text-[11px] leading-[18px] font-bold text-warn">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Link>
      </li>
    );
  };

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop / tablet rail */}
      <nav
        aria-label="Primary"
        className={cx(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface-2 px-2.5 py-2.5 lg:flex",
          collapsed ? "w-[66px]" : "w-[232px]",
        )}
      >
        <div className={cx("mb-1 flex items-center", collapsed ? "justify-center" : "justify-between pl-1.5")}>
          {!collapsed ? (
            <span className="flex items-center gap-2 text-[0.9375rem] font-bold tracking-[-0.01em]">
              <span aria-hidden="true" className="brand-mark" />
              Jarvis
            </span>
          ) : null}
          <button
            type="button"
            onClick={toggleRail}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[8px] text-muted hover:bg-surface hover:text-text"
          >
            <PanelIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          title={collapsed ? "Search (Ctrl K)" : undefined}
          className={cx(
            "mb-2 flex min-h-11 w-full items-center gap-2 rounded-[9px] text-[0.8125rem] text-muted hover:text-text",
            collapsed ? "justify-center hover:bg-surface" : "border border-line bg-surface px-2.5 shadow-[var(--shadow)] hover:border-line-strong",
          )}
        >
          <SearchIcon className="h-4 w-4 shrink-0" />
          <span className={collapsed ? "sr-only" : "flex min-w-0 flex-1 items-center justify-between gap-2 whitespace-nowrap"}>
            Search…
            {!collapsed ? <kbd className="kbd">Ctrl K</kbd> : null}
          </span>
        </button>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <ul>{primary.map(railItem)}</ul>
          {collapsed ? (
            <hr className="my-2 border-line" />
          ) : (
            <p aria-hidden="true" className="eyebrow px-2.5 pt-3 pb-1">
              Spaces
            </p>
          )}
          <ul>{destinations.map(railItem)}</ul>
        </div>
        <div className={cx("mt-2 border-t border-line pt-2", collapsed && "flex flex-col items-center")}>
          {/* Command dock: docked in the rail foot on desktop so it never covers page content. */}
          <CommandDock variant="rail" compact={collapsed} />
          <p className={cx("flex min-h-7 items-center gap-2 px-2.5 text-xs text-muted", collapsed && "justify-center px-0")} role="status">
            <span aria-hidden="true" className={cx("h-2 w-2 shrink-0 rounded-full", online ? "bg-ok" : "bg-warn")} />
            <span className={collapsed ? "sr-only" : "truncate"}>{online ? `Online · ${userName}` : "Offline"}</span>
          </p>
          <ul className={collapsed ? "w-full" : undefined}>{railItem(SETTINGS)}</ul>
        </div>
      </nav>

      <main id="main" ref={mainRef} tabIndex={-1} className="pb-nav min-w-0 flex-1 outline-none">
        {!online ? (
          <div role="status" className="sticky top-0 z-30 border-b border-warn bg-warn-soft px-4 py-2 text-center text-sm text-warn">
            You’re offline. Showing last-known data; changes and home controls are paused.
          </div>
        ) : null}
        {children}
      </main>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      {capturing && canWork ? <CaptureDialog onClose={() => setCapturing(false)} /> : null}

      {/* Phone bottom bar (§5): Home · Areas · [orb] · Alerts · More. Chat and Inbox are reached from the orb / More. */}
      <nav aria-label="Primary" className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        <ul className="mx-auto grid max-w-xl grid-cols-5">
          {[...barItems, MORE].map((d, i, all) => {
            const active = d.key === "more" ? MORE.match(pathname) && !barItems.some((p) => p.match(pathname)) : d.match(pathname);
            const Icon = d.icon;
            // The command dock is the centre item of the bar (never overlapping it).
            const dock =
              i === Math.floor(all.length / 2) ? (
                <li key="dock" className="flex min-h-[60px] items-center justify-center">
                  <CommandDock variant="bar" />
                </li>
              ) : null;
            return [
              dock,
              <li key={d.key}>
                <Link
                  href={d.key === "more" ? "/more" : hrefFor(d)}
                  aria-current={active ? "page" : undefined}
                  aria-label={d.key === "alerts" ? `Alerts${badgeLabel}` : undefined}
                  className={cx(
                    "flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                    active ? "text-accent" : "text-muted",
                  )}
                >
                  <span className="relative">
                    <Icon className="h-[22px] w-[22px]" />
                    {d.key === "alerts" ? badge : null}
                  </span>
                  <span className="block max-w-full truncate px-1">{d.label}</span>
                </Link>
              </li>,
            ];
          })}
        </ul>
      </nav>
    </div>
  );
}
