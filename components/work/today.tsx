"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, ErrorNote, Spinner, cx } from "@/components/ui";
import { StatusBadge, StatusDot, fmtDate, useWorkMutation } from "@/components/work/common";
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
                "block text-[22px] leading-7 font-semibold tracking-tight tabular-nums",
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
              <button type="button" onClick={k.onClick} className="tap wk-kpi" aria-label={`${k.label}: ${k.value ?? "unknown"}`}>
                {body}
              </button>
            ) : (
              <div className="wk-kpi">{body}</div>
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
  urgent,
}: {
  title: string;
  id: string;
  cards: TodayCard[];
  empty: string;
  action: { label: string; do?: string };
  onOpen: (id: string, action?: string) => void;
  /** a warn accent on the rows (proof due) */
  urgent?: boolean;
}) {
  return (
    <section aria-labelledby={id} className="wk-card min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 id={id} className="wk-label">
          {title}
        </h3>
        {cards.length ? <span className="text-xs text-muted tabular-nums">{cards.length}</span> : null}
      </div>
      {cards.length ? (
        <ul className="wk-rows">
          {cards.map((c) => (
            <li
              key={c.id}
              className={cx("wk-row-hover flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2", urgent && "border-l-[3px] border-l-warn pl-[9px]")}
            >
              <StatusDot status={c.status} />
              <div className="min-w-0 flex-1 basis-48">
                <button
                  type="button"
                  className="tap min-w-0 text-left text-[14px] leading-snug font-semibold break-words hover:underline"
                  onClick={() => onOpen(c.id)}
                >
                  {c.title}
                </button>
                <p className="text-xs break-words text-muted">
                  {[c.path, c.detail, c.due ? `due ${fmtDate(c.due)}` : null, c.nextAction ? `Next: ${c.nextAction}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <StatusBadge status={c.status} />
                <Button size="sm" variant={urgent ? "primary" : "secondary"} onClick={() => onOpen(c.id, action.do)} aria-label={`${action.label}: ${c.title}`}>
                  {action.label}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-[13px] text-muted">{empty}</p>
      )}
    </section>
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
  const [y, m, d] = t.today.split("-").map(Number);
  const dateLabel = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  return (
    <section aria-labelledby="today-title" className="space-y-3" data-testid="work-today">
      <div>
        <p className="wk-eyebrow">{dateLabel}</p>
        <h2 id="today-title" className="text-xl leading-tight font-semibold tracking-tight">
          Today
        </h2>
        <p className="mt-0.5 text-[13.5px] text-muted">
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
          // Shown only when something is waiting, so the strip is unchanged for people without AI reports.
          ...(t.kpis.reportsReady ? [{ key: "reports", label: "Reports ready", value: t.kpis.reportsReady, tone: "accent" as const }] : []),
        ]}
      />
      {t.readyForYou?.length ? (
        <section aria-labelledby="today-ready" className="card" data-testid="today-ready">
          <h3 id="today-ready" className="font-semibold">
            Ready for you
          </h3>
          <ul className="wk-rows">
            {t.readyForYou.map((r) => (
              <li key={r.reportId}>
                <a
                  className="tap flex min-w-0 flex-col py-2 hover:bg-surface-2"
                  href={
                    r.itemId
                      ? `/areas?item=${encodeURIComponent(r.itemId)}&report=${encodeURIComponent(r.reportId)}`
                      : `/areas?view=inbox&entry=${encodeURIComponent(r.inboxId ?? "")}`
                  }
                >
                  <span className="truncate text-[14px] font-medium">✦ {r.title}</span>
                  {r.summary ? <span className="line-clamp-1 text-[13px] text-muted">{r.summary}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <CardList
        id="today-continue"
        title="Continue"
        cards={t.continue}
        empty="Nothing in progress. Pick something from the tree and start focused work."
        action={{ label: "Continue" }}
        onOpen={onOpen}
      />
      <div className="grid gap-3 xl:grid-cols-2">
        <CardList
          id="today-proof"
          title="Proof due"
          cards={t.proofDue}
          empty="No work is waiting for validation."
          action={{ label: "Record result", do: "validate" }}
          onOpen={onOpen}
          urgent
        />
        <CardList
          id="today-settle"
          title="PR merged — settle?"
          cards={t.readyToSettle}
          empty="Nothing waiting to be settled."
          action={{ label: "Settle…", do: "settle" }}
          onOpen={onOpen}
        />
        {t.overdue.length ? <CardList id="today-overdue" title="Overdue" cards={t.overdue} empty="" action={{ label: "Open" }} onOpen={onOpen} /> : null}
        {t.settleSuggestions?.length ? (
          <CardList
            id="today-suggest"
            title="Ready to settle?"
            cards={t.settleSuggestions}
            empty=""
            action={{ label: "Settle…", do: "settle" }}
            onOpen={onOpen}
          />
        ) : null}
      </div>
      {t.autoSettled?.length ? <AutoSettled cards={t.autoSettled} onOpen={onOpen} /> : null}
      {inboxCount ? (
        <p className="text-[13px]">
          <button type="button" className="tap text-accent underline" onClick={onInbox}>
            {inboxCount} waiting in the inbox
          </button>
        </p>
      ) : null}
    </section>
  );
}

/** Settled by an area's "settle automatically after a quiet period" policy: always undoable for a week. */
function AutoSettled({ cards, onOpen }: { cards: TodayResponse["autoSettled"]; onOpen: (id: string) => void }) {
  const undo = useWorkMutation((opId: string) => api.post(`/api/work/ops/${encodeURIComponent(opId)}/undo`, {}), { ok: "Reopened" });
  return (
    <section aria-labelledby="today-auto" className="wk-card min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 id="today-auto" className="wk-label">
          Settled automatically
        </h3>
        <span className="text-xs text-muted tabular-nums">{cards.length}</span>
      </div>
      <ul className="wk-rows">
        {cards.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
            <div className="min-w-0 flex-1 basis-48">
              <button type="button" className="tap min-w-0 text-left text-[14px] font-semibold break-words hover:underline" onClick={() => onOpen(c.id)}>
                {c.title}
              </button>
              <p className="text-xs break-words text-muted">{[c.path, c.detail].filter(Boolean).join(" · ")}</p>
            </div>
            {c.opId ? (
              <Button
                size="sm"
                onClick={() => undo.mutate(c.opId!)}
                busy={undo.isPending && undo.variables === c.opId}
                aria-label={`Undo automatic settle: ${c.title}`}
              >
                Undo
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
