"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, cx, useToast, type Tone } from "@/components/ui";
import { api } from "@/lib/client/api";
import { STATUS_LABELS, type GithubRefreshResult, type WorkStatus } from "@/lib/work";

const TABS = [
  { href: "/work", label: "Tree", match: (p: string) => p === "/work" },
  { href: "/work/timeline", label: "Timeline", match: (p: string) => p.startsWith("/work/timeline") },
  { href: "/work/dashboard", label: "Dashboard", match: (p: string) => p.startsWith("/work/dashboard") },
  { href: "/work/map", label: "Map", match: (p: string) => p.startsWith("/work/map") },
];

/**
 * Work section chrome: one slim full-width bar with the brand mark and the
 * Tree / Timeline / Dashboard / Map tabs. `.work-ui` scopes the hub's density
 * rules (components/work/work.css).
 */
export function WorkShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="work-ui">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-3 py-1 sm:px-5">
        <span className="hidden items-center gap-2 text-sm font-semibold sm:inline-flex" aria-hidden="true">
          <i className="inline-block h-[18px] w-[18px] rounded-[6px] bg-[linear-gradient(135deg,var(--accent),var(--violet))]" />
          Work
        </span>
        <nav aria-label="Work">
          <ul className="flex flex-wrap gap-0.5">
            {TABS.map((t) => (
              <li key={t.href}>
                <Link href={t.href} aria-current={t.match(path) ? "page" : undefined} className="wk-navlink">
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <span className="ml-auto hidden items-center gap-1.5 text-xs text-muted xl:inline-flex">
          <kbd className="wk-kbd">Ctrl K</kbd> jump or do · private to you
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Compact page header for Work sub-pages (Timeline, Dashboard, Map): eyebrow,
 * one-line title and actions on a single row; the description is one muted line.
 */
export function WorkPageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        {eyebrow ? <p className="wk-eyebrow">{eyebrow}</p> : null}
        <h1 className="text-xl leading-tight font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
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
      <span className="wk-pill" data-s={status}>
        {STATUS_LABELS[status]}
      </span>
      {/* Rows settled automatically before phase 3; nothing creates them any more. */}
      {auto && status === "settled" ? <Badge tone="neutral">Auto-settled (legacy)</Badge> : null}
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
