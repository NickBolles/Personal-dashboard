"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, useOnline } from "@/components/ui";
import { GearIcon, MoreIcon, PanelIcon } from "@/components/icons";
import { DESTINATIONS, PRIMARY, type Dest } from "./destinations";

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

export function AppShell({ children, userName }: { children: ReactNode; userName: string }) {
  const pathname = usePathname();
  const hrefFor = useNavMemory(pathname);
  const online = useOnline();
  const unread = useUnreadCount().data?.unread ?? 0;
  const [collapsed, setCollapsed] = useState(true);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setCollapsed(localStorage.getItem("jarvis:rail") !== "expanded");
  }, []);
  const toggleRail = () => {
    setCollapsed((c) => {
      localStorage.setItem("jarvis:rail", c ? "expanded" : "collapsed");
      return !c;
    });
  };

  const badge = unread > 0 ? (
    <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-danger px-1 text-center text-[11px] font-semibold leading-5 text-white dark:text-black">
      {unread > 99 ? "99+" : unread}
    </span>
  ) : null;
  const badgeLabel = unread > 0 ? `, ${unread} unread` : "";

  const railItem = (d: Dest) => {
    const active = d.match(pathname);
    const Icon = d.icon;
    return (
      <li key={d.key}>
        <Link
          href={hrefFor(d)}
          aria-current={active ? "page" : undefined}
          title={collapsed ? d.label : undefined}
          className={cx(
            "relative flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium",
            active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
            collapsed && "justify-center px-0",
          )}
        >
          <span className="relative">
            <Icon className="h-6 w-6" />
            {d.key === "alerts" ? badge : null}
          </span>
          <span className={collapsed ? "sr-only" : ""}>
            {d.label}
            {d.key === "alerts" ? badgeLabel : ""}
          </span>
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
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface px-2 py-3 lg:flex",
          collapsed ? "w-[72px]" : "w-[260px]",
        )}
      >
        <div className={cx("mb-3 flex items-center", collapsed ? "justify-center" : "justify-between px-2")}>
          {!collapsed ? <span className="text-lg font-semibold tracking-tight">Jarvis</span> : null}
          <button
            type="button"
            onClick={toggleRail}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            className="tap inline-flex items-center justify-center rounded-xl text-muted hover:bg-surface-2"
          >
            <PanelIcon className="h-5 w-5" />
          </button>
        </div>
        <ul className="space-y-1">{PRIMARY.map(railItem)}</ul>
        <hr className="my-3 border-line" />
        <ul className="space-y-1">{DESTINATIONS.map(railItem)}</ul>
        <div className="mt-auto space-y-1">
          <p className={cx("flex min-h-10 items-center gap-2 px-3 text-xs text-muted", collapsed && "justify-center px-0")} role="status">
            <span aria-hidden="true" className={cx("h-2 w-2 rounded-full", online ? "bg-ok" : "bg-warn")} />
            <span className={collapsed ? "sr-only" : ""}>{online ? `Online · ${userName}` : "Offline"}</span>
          </p>
          <ul>{railItem(SETTINGS)}</ul>
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

      {/* Mobile bottom bar: fixed four items */}
      <nav aria-label="Primary" className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {[...PRIMARY, MORE].map((d) => {
            const active = d.key === "more" ? MORE.match(pathname) && !PRIMARY.some((p) => p.match(pathname)) : d.match(pathname);
            const Icon = d.icon;
            return (
              <li key={d.key}>
                <Link
                  href={d.key === "more" ? "/more" : hrefFor(d)}
                  aria-current={active ? "page" : undefined}
                  className={cx("flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[12px] font-medium", active ? "text-accent" : "text-muted")}
                >
                  <span className="relative">
                    <Icon className="h-6 w-6" />
                    {d.key === "alerts" ? badge : null}
                  </span>
                  <span>
                    {d.label}
                    {d.key === "alerts" ? <span className="sr-only">{badgeLabel}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
