"use client";

import { useAccess } from "@/components/access";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PRIORITY_LABELS, type NextAction, type PrimaryActionKind } from "@/lib/contracts";
import { relativeTime } from "@/lib/time";
import { api } from "@/lib/client/api";
import { Badge, Button, ButtonLink, OverflowMenu, SourceBadge, cx, useNow, useOnline, useToast, type MenuItem, type Tone } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { FeedbackBar } from "@/components/home/Feedback";
import { formatDue } from "./format";

const REASON_TONE: Record<NextAction["priorityReason"], Tone> = {
  critical: "danger",
  awaiting_user: "accent",
  overdue: "danger",
  due_soon: "warn",
  checkin_window: "accent",
  today: "neutral",
  upcoming: "neutral",
};

export function useActionMutation() {
  const qc = useQueryClient();
  const { toast, announce } = useToast();
  return useMutation({
    mutationFn: (v: { actionId: string; kind: PrimaryActionKind | "pin" | "unpin"; until?: string }) => api.post<{ message: string }>("/api/actions", v),
    onSuccess: (res) => {
      toast(res.message, "ok");
      announce(res.message);
      qc.invalidateQueries({ queryKey: ["home"] });
      qc.invalidateQueries({ queryKey: ["source"] });
    },
    onError: (err) => toast((err as Error).message, "danger"),
  });
}

/**
 * One action. `explain` (Home) adds the tier accent and a "Why this?"
 * disclosure with the ranking's reasons and per-person feedback.
 */
export function ActionCard({ action, compact, explain }: { action: NextAction; compact?: boolean; explain?: boolean }) {
  const router = useRouter();
  const online = useOnline();
  const m = useActionMutation();
  const { can } = useAccess();
  const now = useNow();
  const [done, setDone] = useState(false);
  const stale = new Date(action.staleAfter).getTime() < now;
  const due = formatDue(action, now);
  const primary = action.primaryAction;
  const titleId = `act-${action.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const rank = explain ? action.rank : undefined;

  // "Done" only shows after the server confirmed (readback); the card then leaves on refetch.
  const run = (kind: PrimaryActionKind | "pin" | "unpin") => m.mutate({ actionId: action.id, kind }, { onSuccess: () => kind === "complete" && setDone(true) });
  const askHermes = () =>
    router.push(
      `/chat?new=1&context=${encodeURIComponent(`${action.title}${action.detail ? ` — ${action.detail}` : ""} [${action.source}:${action.sourceId}]`)}`,
    );

  const menu: MenuItem[] = [
    ...(action.secondaryActions ?? [])
      .filter((k) => k !== primary?.kind)
      .map((k) => ({
        label: k === "snooze" ? "Snooze until tomorrow" : k === "complete" ? "Mark done" : k === "acknowledge" ? "Acknowledge" : "Open",
        onSelect: () => run(k),
        disabled: !online && k !== "acknowledge",
      })),
    { label: action.pinned ? "Unpin" : "Pin to top", onSelect: () => run(action.pinned ? "unpin" : "pin") },
    // Finance never goes to the AI layer (docs/finance.md).
    ...(can("hermes.chat") && action.source !== "finance" ? [{ label: "Ask Hermes about this", onSelect: askHermes }] : []),
    {
      label: action.external ? "Open in source" : "Open",
      onSelect: () => (action.external ? window.open(action.href, "_blank", "noopener") : router.push(action.href)),
    },
  ];

  return (
    <article aria-labelledby={titleId} data-tier={rank?.tier} className={cx("card flex flex-col gap-2 p-4", rank && "jv-accent pl-5", done && "jv-done")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={action.source} />
            <Badge tone={REASON_TONE[action.priorityReason]}>{PRIORITY_LABELS[action.priorityReason]}</Badge>
            {action.pinned ? <Badge tone="accent">Pinned</Badge> : null}
            {rank?.tier === "compass" ? <Badge tone="accent">Compass focus</Badge> : null}
          </div>
          <h3 id={titleId} className="text-base font-semibold leading-snug">
            {action.external ? (
              <a href={action.href} target="_blank" rel="noreferrer noopener" className="hover:underline">
                {action.title}
              </a>
            ) : (
              <Link href={action.href} className="hover:underline">
                {action.title}
              </Link>
            )}
          </h3>
          {!compact && action.detail ? <p className="text-sm text-muted">{action.detail}</p> : null}
          <p className="text-xs text-muted">
            {due ? <span>{due}</span> : null}
            {due && stale ? " · " : null}
            {stale ? <span className="text-warn">Last updated {relativeTime(action.fetchedAt, now)}</span> : null}
          </p>
        </div>
        <OverflowMenu label={`More actions for ${action.title}`} items={menu} />
      </div>
      {primary && !compact ? (
        <div className="flex gap-2">
          {primary.kind === "open" ? (
            <ButtonLink href={action.href} external={action.external} variant="primary" className="min-h-11 text-sm" aria-describedby={titleId}>
              {primary.label}
            </ButtonLink>
          ) : (
            <Button
              variant="primary"
              size="sm"
              busy={m.isPending}
              disabled={!online || done}
              title={!online ? "Unavailable offline" : undefined}
              onClick={() => run(primary.kind)}
              aria-describedby={titleId}
            >
              {done ? (
                <>
                  <svg className="jv-check h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Done
                </>
              ) : (
                primary.label
              )}
            </Button>
          )}
        </div>
      ) : null}
      {rank && action.why?.length ? (
        <details className="jv-why group -mx-1">
          <summary className="tap inline-flex items-center gap-1 rounded-[8px] px-1 text-xs font-medium text-muted hover:text-text">
            <span>Why this?</span>
            <span className="sr-only"> ({action.title})</span>
            <ChevronIcon className="h-4 w-4 transition-transform group-open:rotate-90" />
          </summary>
          <div className="jv-rise space-y-3 px-1 pb-1 pt-1">
            <ul className="space-y-0.5 text-sm text-muted">
              {action.why.map((w) => (
                <li key={w}>· {w}</li>
              ))}
            </ul>
            <FeedbackBar
              canHide={rank.tier !== "critical"}
              target={{
                kind: "action",
                id: action.id,
                category: rank.category,
                title: action.title,
                fingerprint: rank.fingerprint,
                why: action.why,
                sources: [action.source],
              }}
            />
          </div>
        </details>
      ) : null}
    </article>
  );
}
