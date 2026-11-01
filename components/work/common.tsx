"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ComponentType, type ReactNode } from "react";
import { AreasIcon, InboxIcon, SunIcon } from "@/components/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, cx, useToast, type Tone } from "@/components/ui";
import { api } from "@/lib/client/api";
import { STATUS_LABELS, type GithubRefreshResult, type WorkStatus } from "@/lib/work";

export type AreasSection = "today" | "inbox" | "tree" | "timeline" | "dashboard" | "map";

const SECTIONS: { key: AreasSection; href: string; label: string; icon?: ComponentType<{ className?: string }> }[] = [
  { key: "today", href: "/areas", label: "Today", icon: SunIcon },
  { key: "inbox", href: "/inbox", label: "Inbox", icon: InboxIcon },
  { key: "tree", href: "/areas?view=tree", label: "Areas", icon: AreasIcon },
  { key: "timeline", href: "/areas/timeline", label: "Timeline" },
  { key: "dashboard", href: "/areas/dashboard", label: "Dashboard" },
  { key: "map", href: "/areas/map", label: "Map" },
];
const IN_PAGE = new Set<AreasSection>(["today", "tree"]);

/**
 * Areas section wrapper. `.work-ui` scopes the hub's density rules
 * (components/work/work.css).
 */
export function WorkShell({ children }: { children: ReactNode }) {
  return <div className="work-ui">{children}</div>;
}

/**
 * The one Areas navigation row: Today · Inbox · Areas │ Timeline · Dashboard · Map.
 * On /areas the first three switch in place (`onPick`, rendered as buttons);
 * everywhere else every entry is a link. Scrolls sideways on narrow phones.
 */
export function AreasNav({
  current,
  onPick,
  inboxCount,
  className,
}: {
  current: AreasSection | null;
  onPick?: (k: "today" | "inbox" | "tree") => void;
  inboxCount?: number;
  className?: string;
}) {
  const path = usePathname();
  const active = current ?? SECTIONS.find((s) => !IN_PAGE.has(s.key) && path.startsWith(s.href))?.key ?? null;
  return (
    <nav aria-label="Areas sections" className={cx("wk-nav", className)}>
      <ul>
        {SECTIONS.map((s, n) => {
          const body = (
            <>
              {s.icon ? <s.icon className="h-4 w-4 shrink-0 text-muted" /> : null}
              <span>{s.label}</span>
              {s.key === "inbox" && inboxCount ? (
                <span className="wk-count" aria-label={`${inboxCount} waiting`}>
                  {inboxCount}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={s.key} className={n === 3 ? "wk-nav-sep" : undefined}>
              {onPick && IN_PAGE.has(s.key) ? (
                <button type="button" className="wk-nav-item" aria-current={active === s.key ? "page" : undefined} onClick={() => onPick(s.key as "today")}>
                  {body}
                </button>
              ) : (
                <Link href={s.href} className="wk-nav-item" aria-current={active === s.key ? "page" : undefined}>
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Compact page header for Areas sub-pages (Timeline, Dashboard, Map): the
 * nav row, then eyebrow/title and actions on one row.
 */
export function WorkPageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-3 space-y-2">
      <AreasNav current={null} />
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {eyebrow ? <p className="wk-eyebrow">{eyebrow}</p> : null}
          <h1 className="text-xl leading-tight font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Micro-label + hairline card used across the hub (rail blocks, Today sections, widgets). */
export function Block({
  label,
  aside,
  children,
  className,
  labelId,
}: {
  label: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  labelId?: string;
}) {
  return (
    <div className={cx("wk-blk", className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 id={labelId} className="wk-label">
          {label}
        </h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

export const STATUS_TONE: Record<WorkStatus, Tone> = {
  captured: "neutral",
  exploring: "neutral",
  ready: "accent",
  in_progress: "accent",
  in_review: "accent",
  awaiting_validation: "warn",
  ready_to_settle: "accent",
  settled: "ok",
  reopened: "danger",
  on_hold: "neutral",
  superseded: "neutral",
  abandoned: "neutral",
};

/** Solid colours for dots and Gantt bars. */
export const STATUS_FILL: Record<WorkStatus, string> = {
  captured: "bg-line-strong",
  exploring: "bg-line-strong",
  ready: "bg-accent",
  in_progress: "bg-accent",
  in_review: "bg-accent",
  awaiting_validation: "bg-warn",
  ready_to_settle: "bg-ok",
  settled: "bg-ok",
  reopened: "bg-danger",
  on_hold: "bg-line",
  superseded: "bg-line",
  abandoned: "bg-line",
};

export function StatusDot({ status }: { status: WorkStatus }) {
  return <span aria-hidden="true" className="wk-dot" data-s={status} />;
}

/** Status pill with a dot (artifact `.pill.s-*`). `data-status` is the stable hook for tests. */
export function StatusBadge({ status, auto }: { status: WorkStatus; auto?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-status={status}>
      <span className="status-pill" data-s={status}>
        {STATUS_LABELS[status]}
      </span>
      {/* Settled by an area's auto_after_quiet policy (or before phase 3). */}
      {auto && status === "settled" ? <Badge tone="neutral">Auto-settled</Badge> : null}
    </span>
  );
}

/** Mutation that refreshes every Work query and toasts errors. */
export function useWorkMutation<V, R = unknown>(fn: (v: V) => Promise<R>, opts: { ok?: string; onSuccess?: (r: R, v: V) => void } = {}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.ok) toast(opts.ok, "ok");
      qc.invalidateQueries({ queryKey: ["work"] });
      opts.onSuccess?.(r, v);
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
}

export function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Read-only GitHub refresh when an item is viewed or the dashboard loads. The
 * server throttles per link and caps each request, so remounts are cheap.
 * Failures stay quiet here: each link shows its own last check result.
 */
export function useGithubAutoRefresh(enabled: boolean, itemId?: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api
      .post<GithubRefreshResult>("/api/work/github/refresh", itemId ? { itemId } : {})
      .then((r) => {
        if (live && r.changed) qc.invalidateQueries({ queryKey: ["work"] });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, itemId, qc]);
}
