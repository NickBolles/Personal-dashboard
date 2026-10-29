"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JarvisNotification } from "@/lib/contracts";
import { relativeTime } from "@/lib/time";
import { api } from "@/lib/client/api";
import { Badge, Button, Empty, ErrorNote, OverflowMenu, Page, PageHeader, SourceBadge, Spinner, cx, useToast, type Tone } from "@/components/ui";
import { AlertIcon, BellIcon } from "@/components/icons";

const SEVERITY: Record<JarvisNotification["severity"], { tone: Tone; label: string }> = {
  critical: { tone: "danger", label: "Critical" },
  high: { tone: "warn", label: "High" },
  normal: { tone: "accent", label: "Normal" },
  info: { tone: "neutral", label: "Info" },
};

export function AlertsView() {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<"inbox" | "all">("inbox");
  const q = useQuery({
    queryKey: ["notifications", filter],
    queryFn: () => api.get<{ notifications: JarvisNotification[]; unread: number }>(`/api/notifications?filter=${filter}`),
    refetchInterval: 30_000,
  });
  const t = useMutation({
    mutationFn: (v: { id: string; transition: "read" | "unread" | "dismiss" | "restore" | "acted" }) =>
      api.patch(`/api/notifications/${v.id}`, { transition: v.transition }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const readAll = useMutation({
    mutationFn: () => api.post("/api/notifications/read-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const open = async (n: JarvisNotification) => {
    if (!n.readAt) await t.mutateAsync({ id: n.id, transition: "read" }).catch(() => undefined);
    router.push(n.deepLink);
  };

  const list = q.data?.notifications ?? [];

  return (
    <Page width="medium">
      <PageHeader
        title="Alerts"
        subtitle={q.data ? `${q.data.unread} unread actionable` : undefined}
        actions={
          <Button size="sm" onClick={() => readAll.mutate()} disabled={!q.data?.unread} busy={readAll.isPending}>
            Mark all read
          </Button>
        }
      />
      <div
        role="tablist"
        aria-label="Filter alerts"
        className="mb-3 inline-flex max-w-full flex-wrap gap-0.5 rounded-[10px] border border-line bg-surface-2 p-0.5"
      >
        {(["inbox", "all"] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cx(
              "min-h-10 rounded-[8px] px-3 text-sm font-medium dense:min-h-7",
              filter === f ? "bg-surface text-text shadow-[var(--shadow)] ring-1 ring-line" : "text-muted hover:text-text",
            )}
          >
            {f === "inbox" ? "Inbox" : "All, including dismissed"}
          </button>
        ))}
      </div>
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.isLoading ? <Spinner label="Loading alerts…" /> : null}
      {q.data && !list.length ? <Empty title="You're all caught up">New alerts from Hermes, home, and your sources will appear here.</Empty> : null}
      <ul className={cx("rows", list.length > 0 && "card p-0")} data-dynamic>
        {list.map((n) => {
          const sev = SEVERITY[n.severity];
          const unread = !n.readAt && !n.dismissedAt;
          const loud = n.severity === "critical" || n.severity === "high";
          return (
            <li
              key={n.id}
              data-id={n.id}
              data-tier={unread ? "awaiting_user" : undefined}
              className={cx("px-3.5 py-3 dense:py-2.5", unread && "jv-accent", n.dismissedAt && "opacity-70")}
            >
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
                <span
                  aria-hidden="true"
                  className={cx(
                    "mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-[7px]",
                    loud ? "bg-danger-soft text-danger" : "bg-surface-2 text-muted",
                  )}
                >
                  {loud ? <AlertIcon className="h-4 w-4" /> : <BellIcon className="h-4 w-4" />}
                </span>
                <div className="min-w-0 space-y-0.5">
                  <h2 className="text-[0.9375rem] leading-snug font-semibold dense:text-[0.875rem]">
                    <button type="button" className="block w-full text-left [overflow-wrap:anywhere] hover:underline" onClick={() => open(n)}>
                      {n.title}
                    </button>
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tone={sev.tone} dot>
                      {sev.label}
                    </Badge>
                    <SourceBadge source={n.source} />
                    {unread ? <Badge tone="accent">Unread</Badge> : null}
                    {n.actedAt ? <Badge tone="ok">Done</Badge> : null}
                    {n.dismissedAt ? <Badge>Dismissed</Badge> : null}
                  </div>
                  <p className="text-sm text-muted">{n.body}</p>
                  <p className="text-xs text-muted">
                    {relativeTime(n.updatedAt)}
                    {n.occurrences > 1 ? ` · seen ${n.occurrences} times` : ""}
                  </p>
                </div>
                <div className="col-start-2 row-start-2 flex flex-wrap gap-2 sm:col-start-3 sm:row-start-1 sm:self-center">
                  {!n.actedAt ? (
                    <Button size="sm" variant="secondary" onClick={() => t.mutate({ id: n.id, transition: "acted" })}>
                      Mark done
                    </Button>
                  ) : null}
                </div>
                <div className="col-start-3 row-start-1 sm:col-start-4 sm:self-center">
                  <OverflowMenu
                    label={`More actions for ${n.title}`}
                    items={[
                      { label: "Open", onSelect: () => open(n) },
                      n.readAt
                        ? { label: "Mark unread", onSelect: () => t.mutate({ id: n.id, transition: "unread" }) }
                        : { label: "Mark read", onSelect: () => t.mutate({ id: n.id, transition: "read" }) },
                      n.dismissedAt
                        ? { label: "Restore to inbox", onSelect: () => t.mutate({ id: n.id, transition: "restore" }) }
                        : { label: "Dismiss", onSelect: () => t.mutate({ id: n.id, transition: "dismiss" }) },
                    ]}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}
