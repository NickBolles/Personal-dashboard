"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Card, ErrorNote, Spinner, cx } from "@/components/ui";
import { StatusBadge, fmtDate } from "@/components/work/common";
import type { InboxResponse, TodayCard, TodayResponse } from "@/lib/work";

export function useToday() {
  return useQuery({ queryKey: ["work", "today"], queryFn: () => api.get<TodayResponse>("/api/work/today") });
}
export function useInbox() {
  return useQuery({ queryKey: ["work", "inbox"], queryFn: () => api.get<InboxResponse>("/api/work/inbox"), staleTime: 15_000 });
}

type Kpi = { key: string; label: string; value: number | null; tone?: "warn" | "danger" | "ok" | "accent"; onClick?: () => void };

/** The Command Center KPI strip (Direction C): dense numbers, each a way in. */
export function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  return (
    <ul aria-label="Work at a glance" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {kpis.map((k) => {
        const body = (
          <>
            <span
              className={cx(
                "block text-2xl leading-tight font-semibold tabular-nums",
                !!k.value && k.tone === "warn" && "text-warn",
                !!k.value && k.tone === "danger" && "text-danger",
                !!k.value && k.tone === "ok" && "text-ok",
                !!k.value && k.tone === "accent" && "text-accent",
              )}
            >
              {k.value ?? "—"}
            </span>
            <span className="block text-xs text-muted">{k.label}</span>
          </>
        );
        return (
          <li key={k.key} data-kpi={k.key}>
            {k.onClick ? (
              <button
                type="button"
                onClick={k.onClick}
                className="tap card block w-full p-3 text-left hover:bg-surface-2"
                aria-label={`${k.label}: ${k.value ?? "unknown"}`}
              >
                {body}
              </button>
            ) : (
              <div className="card p-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CardList({
  title,
  id,
  cards,
  empty,
  action,
  onOpen,
}: {
  title: string;
  id: string;
  cards: TodayCard[];
  empty: string;
  action: { label: string; do?: string };
  onOpen: (id: string, action?: string) => void;
}) {
  return (
    <Card as="section" aria-labelledby={id} className="min-w-0 p-3">
      <h3 id={id} className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">
        {title}
      </h3>
      {cards.length ? (
        <ul className="divide-y divide-line">
          {cards.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0 flex-1">
                <button type="button" className="tap min-w-0 text-left font-medium break-words hover:underline" onClick={() => onOpen(c.id)}>
                  {c.title}
                </button>
                <p className="text-xs break-words text-muted">
                  {[c.path, c.detail, c.due ? `due ${fmtDate(c.due)}` : null, c.nextAction ? `Next: ${c.nextAction}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                <StatusBadge status={c.status} />
                <Button size="sm" onClick={() => onOpen(c.id, action.do)} aria-label={`${action.label}: ${c.title}`}>
                  {action.label}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{empty}</p>
      )}
    </Card>
  );
}

/** Today: the /work front door. Continue first, then what needs proof, settling or attention. */
export function TodayView({ onOpen, onInbox }: { onOpen: (id: string, action?: string) => void; onInbox: () => void }) {
  const q = useToday();
  const inbox = useInbox();
  if (q.isPending) return <Spinner label="Loading today…" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const t = q.data;
  const inboxCount = inbox.data?.count ?? null;
  const first = t.continue[0];
  return (
    <section aria-labelledby="today-title" className="space-y-4" data-testid="work-today">
      <div>
        <h2 id="today-title" className="text-xl font-semibold">
          Today
        </h2>
        <p className="text-sm text-muted">
          {t.proofDue.length ? `${t.proofDue.length === 1 ? "One thing needs" : `${t.proofDue.length} things need`} proof` : "Nothing is waiting on proof"}
          {first ? `, and “${first.title}” is ready to continue.` : "."}
        </p>
      </div>
      <KpiStrip
        kpis={[
          { key: "in_progress", label: "In progress", value: t.kpis.inProgress, tone: "accent" },
          { key: "awaiting_validation", label: "Awaiting validation", value: t.kpis.awaitingValidation, tone: "warn" },
          { key: "overdue", label: "Overdue", value: t.kpis.overdue, tone: "danger" },
          { key: "inbox", label: "In the inbox", value: inboxCount, tone: "accent", onClick: onInbox },
          { key: "merged", label: "Merged, not settled", value: t.kpis.mergedNotSettled, tone: "ok" },
        ]}
      />
      <CardList
        id="today-continue"
        title="Continue"
        cards={t.continue}
        empty="Nothing in progress. Pick something from the tree and start focused work."
        action={{ label: "Continue" }}
        onOpen={onOpen}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <CardList
          id="today-proof"
          title="Proof due"
          cards={t.proofDue}
          empty="No work is waiting for validation."
          action={{ label: "Record result", do: "validate" }}
          onOpen={onOpen}
        />
        <CardList
          id="today-settle"
          title="PR merged — settle?"
          cards={t.readyToSettle}
          empty="Nothing waiting to be settled."
          action={{ label: "Settle…", do: "settle" }}
          onOpen={onOpen}
        />
      </div>
      {t.overdue.length ? <CardList id="today-overdue" title="Overdue" cards={t.overdue} empty="" action={{ label: "Open" }} onOpen={onOpen} /> : null}
      {inboxCount ? (
        <p className="text-sm">
          <button type="button" className="tap text-accent underline" onClick={onInbox}>
            {inboxCount} waiting in the inbox
          </button>
        </p>
      ) : null}
    </section>
  );
}
