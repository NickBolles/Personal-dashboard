"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, cx, useToast, type Tone } from "@/components/ui";
import { STATUS_LABELS, type WorkStatus } from "@/lib/work";

const TABS = [
  { href: "/work", label: "Tree", match: (p: string) => p === "/work" },
  { href: "/work/timeline", label: "Timeline", match: (p: string) => p.startsWith("/work/timeline") },
  { href: "/work/dashboard", label: "Dashboard", match: (p: string) => p.startsWith("/work/dashboard") },
];

/** Work section chrome: Tree / Timeline / Dashboard tabs. */
export function WorkShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-5 sm:px-6">
        <nav aria-label="Work">
          <ul className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={t.match(path) ? "page" : undefined}
                  className={cx(
                    "inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium",
                    t.match(path) ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {children}
    </>
  );
}

export const STATUS_TONE: Record<WorkStatus, Tone> = {
  captured: "neutral",
  exploring: "neutral",
  ready: "accent",
  in_progress: "accent",
  in_review: "accent",
  awaiting_validation: "warn",
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
  settled: "bg-ok",
  reopened: "bg-danger",
  on_hold: "bg-line",
  superseded: "bg-line",
  abandoned: "bg-line",
};

export function StatusDot({ status }: { status: WorkStatus }) {
  return <span aria-hidden="true" className={cx("inline-block h-2.5 w-2.5 shrink-0 rounded-full", STATUS_FILL[status])} />;
}

export function StatusBadge({ status, auto }: { status: WorkStatus; auto?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-status={status}>
      <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
      {auto && status === "settled" ? <Badge tone="accent">Auto-settled</Badge> : null}
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
