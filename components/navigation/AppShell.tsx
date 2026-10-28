"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, useOnline } from "@/components/ui";
import { ChatIcon, ChevronIcon, GearIcon, MoreIcon, PlusIcon, SearchIcon, TodoIcon } from "@/components/icons";
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

const INBOX: Dest = { key: "inbox", href: "/areas?view=inbox", label: "Inbox", icon: TodoIcon, match: () => false };
const CHAT: Dest = { key: "chat", href: "/chat", label: "Chat", icon: ChatIcon, match: (p) => p.startsWith("/chat") };
const isAreasPath = (p: string) => p === "/areas" || p.startsWith("/areas/") || p === "/work" || p.startsWith("/work/");

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

export function AppShell({ children, userName }: { children: ReactNode; userName: string }) {
  const pathname = usePathname();
  const hrefFor = useNavMemory(pathname);
  const online = useOnline();
  const unread = useUnreadCount().data?.unread ?? 0;
  const mainRef = useRef<HTMLElement>(null);
  const { capabilities } = useAccess();
  const primary = PRIMARY.filter((d) => allowed(d, capabilities));
  // The phone bar holds four destinations around the orb; Hermes-only people (no Areas) keep Chat.
  const barItems = primary.filter((d) => d.key !== "chat" || !primary.some((p) => p.key === "areas")).slice(0, 3);
  const hasAreas = primary.some((p) => p.key === "areas");
  const canChat = capabilities.includes("hermes.chat");
  // Desktop/tablet top row (§5): Today · Inbox · Areas · Chat · Alerts · More.
  const topItems: Dest[] = [
    ...primary.filter((d) => d.key === "home"),
    ...(hasAreas ? [INBOX, { ...primary.find((d) => d.key === "areas")!, match: isAreasPath }] : []),
    ...(canChat ? [CHAT] : []),
    ...primary.filter((d) => d.key === "alerts"),
    MORE,
  ];
  const [searchOpen, setSearchOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
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

  const initials =
    userName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  // Top-row items keep a 44px hit area (touch laptops; e2e a11y contract); labels drop to icons below 1024px.
  const topItem = (d: Dest) => {
    const active = d.key === "more" ? MORE.match(pathname) && !topItems.some((p) => p.key !== "more" && p.match(pathname)) : d.match(pathname);
    const Icon = d.icon;
    return (
      <li key={d.key}>
        <Link
          href={d.key === "more" || d.key === "inbox" ? d.href : hrefFor(d)}
          aria-current={active ? "page" : undefined}
          aria-label={d.key === "alerts" ? `Alerts${badgeLabel}` : undefined}
          title={d.label}
          className={cx(
            "relative flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-[8px] px-2 text-[0.875rem] lg:px-2.5",
            active ? "bg-surface-2 font-semibold text-text" : "text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          <span className="relative">
            <Icon className={cx("h-[18px] w-[18px]", active ? "text-accent" : "")} />
            {d.key === "alerts" ? badge : null}
          </span>
          <span className="sr-only lg:not-sr-only">{d.label}</span>
        </Link>
      </li>
    );
  };
  const newPrimary = () => {
    setNewMenu(false);
    if (canWork) setCapturing(true);
    else if (canChat) window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT, { detail: { areaId: null } }));
  };

  return (
    <div className="min-h-dvh">
      {/* Desktop / tablet: one top row (§5). */}
      <header className="hidden border-b border-line bg-surface sm:block">
        <nav aria-label="Primary" className="flex h-11 items-center gap-1 px-2 lg:px-3">
          <Link
            href="/home"
            aria-label="Jarvis home"
            className="mr-1 flex min-h-11 min-w-11 items-center justify-center gap-2 px-1.5 text-[0.9375rem] font-bold tracking-[-0.01em]"
          >
            <span aria-hidden="true" className="brand-mark" />
            <span className="hidden xl:inline">Jarvis</span>
          </Link>
          <ul className="flex min-w-0 items-center gap-0.5">{topItems.map(topItem)}</ul>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search (Ctrl K)"
            title="Search (Ctrl K)"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-text"
          >
            <SearchIcon className="h-[18px] w-[18px]" />
          </button>
          {canWork || canChat ? (
            <div className="relative flex items-center">
              <button
                type="button"
                onClick={newPrimary}
                aria-label={canWork ? "New capture" : "New chat"}
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-l-[8px] bg-accent px-3 text-[0.8125rem] font-semibold text-accent-contrast hover:opacity-90"
              >
                <PlusIcon className="h-4 w-4" />
                <span className="hidden lg:inline">New</span>
              </button>
              <button
                type="button"
                onClick={() => setNewMenu((o) => !o)}
                aria-label="More new options"
                aria-haspopup="menu"
                aria-expanded={newMenu}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-r-[8px] border-l border-black/15 bg-accent text-accent-contrast hover:opacity-90"
              >
                <ChevronIcon className="h-3.5 w-3.5 rotate-90" />
              </button>
              {newMenu ? (
                <div
                  role="menu"
                  aria-label="New"
                  className="absolute top-full right-0 z-50 mt-1 w-44 rounded-[10px] border border-line bg-surface p-1 shadow-[var(--sh2,var(--shadow))]"
                >
                  {canWork ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setNewMenu(false);
                        setCapturing(true);
                      }}
                      className="flex min-h-11 w-full items-center rounded-[8px] px-2.5 text-left text-sm hover:bg-surface-2"
                    >
                      Capture
                    </button>
                  ) : null}
                  {canChat ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setNewMenu(false);
                        window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT, { detail: { areaId: null } }));
                      }}
                      className="flex min-h-11 w-full items-center rounded-[8px] px-2.5 text-left text-sm hover:bg-surface-2"
                    >
                      Chat
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <Link
            href={hrefFor(SETTINGS)}
            aria-label={`Settings · ${online ? "online" : "offline"} · ${userName}`}
            aria-current={SETTINGS.match(pathname) ? "page" : undefined}
            title={online ? `Online · ${userName}` : "Offline"}
            className="relative ml-1 inline-flex min-h-11 min-w-11 items-center justify-center"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-[11px] font-bold text-text ring-1 ring-line"
            >
              {initials}
            </span>
            <span aria-hidden="true" className={cx("absolute right-1.5 bottom-1.5 h-2 w-2 rounded-full ring-2 ring-surface", online ? "bg-ok" : "bg-warn")} />
          </Link>
        </nav>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className="pb-nav min-w-0 outline-none">
        {!online ? (
          <div role="status" className="sticky top-0 z-30 border-b border-warn bg-warn-soft px-4 py-2 text-center text-sm text-warn">
            You’re offline. Showing last-known data; changes and home controls are paused.
          </div>
        ) : null}
        {children}
      </main>
      {/* Tablet / desktop: bottom-centre command dock (§5). Chat has its own composer there. */}
      {!pathname.startsWith("/chat") ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-3 z-40 hidden justify-center px-4 sm:flex">
          <div className="pointer-events-auto w-full max-w-[520px]">
            <CommandDock variant="dock" />
          </div>
        </div>
      ) : null}
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      {capturing && canWork ? <CaptureDialog onClose={() => setCapturing(false)} /> : null}

      {/* Phone bottom bar (§5): Today · Areas · [orb] · Alerts · More. Chat and Inbox are reached from the orb / More. */}
      <nav aria-label="Primary" className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur sm:hidden">
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
