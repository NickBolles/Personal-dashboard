"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JarvisNotification } from "@/lib/contracts";
import { relativeTime } from "@/lib/time";
import { api } from "@/lib/client/api";
import { Badge, Button, Empty, ErrorNote, OverflowMenu, PageHeader, SourceBadge, Spinner, cx, useToast, type Tone } from "@/components/ui";
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
    mutationFn: (v: { id: string; transition: "read" | "unread" | "dismiss" | "restore" | "acted" }) => api.patch(`/api/notifications/${v.id}`, { transition: v.transition }),
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
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Alerts"
        subtitle={q.data ? `${q.data.unread} unread actionable` : undefined}
        actions={
          <Button size="sm" onClick={() => readAll.mutate()} disabled={!q.data?.unread} busy={readAll.isPending}>
            Mark all read
          </Button>
        }
      />
      <div role="tablist" aria-label="Filter alerts" className="mb-4 inline-flex rounded-xl border border-line bg-surface p-1">
        {(["inbox", "all"] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cx("min-h-10 rounded-lg px-4 text-sm font-medium", filter === f ? "bg-accent-soft text-accent" : "text-muted")}
          >
            {f === "inbox" ? "Inbox" : "All, including dismissed"}
          </button>
        ))}
      </div>
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.isLoading ? <Spinner label="Loading alerts…" /> : null}
      {q.data && !list.length ? <Empty title="You're all caught up">New alerts from Hermes, home, and your sources will appear here.</Empty> : null}
      <ul className="space-y-2">
        {list.map((n) => {
          const sev = SEVERITY[n.severity];
          const unread = !n.readAt && !n.dismissedAt;
          return (
            <li key={n.id} className={cx("card p-4", unread && "border-l-4 border-l-accent", n.dismissedAt && "opacity-70")}>
              <div className="flex items-start gap-3">
                <span className={cx("mt-0.5", n.severity === "critical" || n.severity === "high" ? "text-danger" : "text-muted")}>
                  {n.severity === "critical" || n.severity === "high" ? <AlertIcon className="h-5 w-5" /> : <BellIcon className="h-5 w-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={sev.tone}>{sev.label}</Badge>
                    <SourceBadge source={n.source} />
                    {unread ? <Badge tone="accent">Unread</Badge> : null}
                    {n.actedAt ? <Badge tone="ok">Done</Badge> : null}
                    {n.dismissedAt ? <Badge>Dismissed</Badge> : null}
                  </div>
                  <h2 className="mt-1 font-semibold">
                    <button type="button" className="text-left hover:underline" onClick={() => open(n)}>
                      {n.title}
                    </button>
                  </h2>
                  <p className="text-sm text-muted">{n.body}</p>
                  <p className="mt-1 text-xs text-muted">
                    {relativeTime(n.updatedAt)}
                    {n.occurrences > 1 ? ` · seen ${n.occurrences} times` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" onClick={() => open(n)}>
                      Open
                    </Button>
                    {!n.actedAt ? (
                      <Button size="sm" onClick={() => t.mutate({ id: n.id, transition: "acted" })}>
                        Mark done
                      </Button>
                    ) : null}
                  </div>
                </div>
                <OverflowMenu
                  label={`More actions for ${n.title}`}
                  items={[
                    n.readAt ? { label: "Mark unread", onSelect: () => t.mutate({ id: n.id, transition: "unread" }) } : { label: "Mark read", onSelect: () => t.mutate({ id: n.id, transition: "read" }) },
                    n.dismissedAt ? { label: "Restore to inbox", onSelect: () => t.mutate({ id: n.id, transition: "restore" }) } : { label: "Dismiss", onSelect: () => t.mutate({ id: n.id, transition: "dismiss" }) },
                  ]}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
