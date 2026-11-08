"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import type { FinanceOverview } from "@/server/finance/overview";
import { ErrorNote, PageHeader, cx, useToast, LoadingState, SectionHeader, Pill, Button, ButtonLink, Card, EmptyState } from "@/components/ui";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { useAccess } from "@/components/access";
import { Delta, Money } from "@/components/finance/money";
import { FinanceSnapshotCards } from "@/components/finance/FinanceSnapshotCards";
import { StartCheckinButton, monthLabel } from "./checkin/CheckinList";

const TONE = { ready: "ok", attention: "wn", failed: "bad", setup: "ac" } as const;
const WORD = { ready: "Ready", attention: "Needs attention", failed: "Refresh failed", setup: "Set up" } as const;

export function FinanceOverviewView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useAccess();
  const q = useQuery({ queryKey: ["finance", "overview"], queryFn: () => api.get<FinanceOverview>("/api/finance/overview") });
  const refresh = useMutation({
    mutationFn: () => api.post<{ outcome: string }>("/api/finance/refresh"),
    onSuccess: (r) => {
      toast(r.outcome === "ready" ? "Balances refreshed" : "Refreshed, with things to look at", r.outcome === "ready" ? "ok" : "warn");
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => {
      toast((e as Error).message, "danger");
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
  });
  if (q.isPending || q.error)
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
        <PageHeader title="Finance" subtitle="Plans and records. Jarvis never moves money." />
        {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : <LoadingState label="Loading finances" />}
      </div>
    );
  const o = q.data;
  const month = o.month;
  return (
    <div className="@container mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader
        title="Finance"
        subtitle="Plans and records. Jarvis never moves money."
        actions={
          can("finance.edit") && o.setup.accounts ? (
            o.setup.balanceSource === "monarch" ? (
              <Button className="whitespace-normal" loading={refresh.isPending} onClick={() => refresh.mutate()}>
                Refresh balances
              </Button>
            ) : (
              <ButtonLink href="/finance/accounts">Enter balances</ButtonLink>
            )
          ) : null
        }
      />
      {o.setup.accounts ? <FinanceSnapshotCards snapshot={o.snapshot} /> : null}
      <div
        role="status"
        className={cx("card flex flex-wrap items-center gap-3 p-4", o.status === "failed" && "border-danger", o.status === "attention" && "border-warn")}
      >
        <Pill tone={TONE[o.status]}>
          {o.status === "ready" ? <CheckIcon className="h-3.5 w-3.5" /> : <AlertIcon className="h-3.5 w-3.5" />} {WORD[o.status]}
        </Pill>
        <span className="font-medium">{o.statusText}</span>
        <span className="text-sm text-muted">
          {o.asOf ? `Balances as of ${relativeTime(o.asOf)}` : o.setup.accounts ? "Some balances have no known as-of time" : ""}
        </span>
      </div>
      {o.setup.releaseBlocker ? (
        <div role="alert" className="card border-danger p-4 text-sm">
          <p className="font-semibold text-danger">Release blocker: Monarch isn’t validated</p>
          <p className="mt-1">
            Monarch has no supported API. Until one refresh succeeds against your real account, automatic balances aren’t proven. Manual and CSV input work
            meanwhile; they don’t count as a substitute.
          </p>
        </div>
      ) : null}
      {!o.setup.accounts ? (
        <EmptyState title="No accounts yet" action={<ButtonLink href="/finance/accounts">Add accounts</ButtonLink>}>
          Add checking, savings and cards, then set your checking cushion.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <SectionHeader label="Where we stand" />
            {o.totals ? (
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-sm text-muted">Net position (all accounts)</dt>
                  <dd className="text-xl">
                    <Money value={o.totals.net} strong />
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Liquid cash (banks only)</dt>
                  <dd className="text-xl">
                    <Money value={o.totals.liquid} strong />
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Checking reserve (a restriction)</dt>
                  <dd>
                    <Money value={o.totals.reserve} />
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Unrestricted checking</dt>
                  <dd>
                    <Money value={o.totals.unrestricted} />
                  </dd>
                </div>
                {o.totals.inTransit ? (
                  <div>
                    <dt className="text-sm text-muted">In transit</dt>
                    <dd>
                      <Delta value={o.totals.inTransit} />
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-muted">Start a check-in to see totals after planned actions.</p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {o.checkin && o.checkin.month === month ? (
                <ButtonLink href={`/finance/checkin/${o.checkin.id}`} variant="primary">
                  Open {monthLabel(o.checkin.month)} check-in
                </ButtonLink>
              ) : (
                <StartCheckinButton month={month} label={`Start ${monthLabel(month)} check-in`} />
              )}
              <ButtonLink href="/finance/checkin?all=1">All check-ins</ButtonLink>
            </div>
          </Card>
          <Card>
            <SectionHeader label="Coming up (30 days)" />
            {o.upcoming.length ? (
              <ul className="mt-2 space-y-2 text-sm">
                {o.upcoming.map((u) => (
                  <li key={u.id} className="flex justify-between gap-2">
                    <span>
                      <span className="text-muted">{u.date}</span> {u.label} {u.kind === "plan" ? <Pill>Plan</Pill> : null}
                    </span>
                    {u.amount !== undefined ? <Delta value={u.amount} /> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">
                Nothing scheduled. Add bills and paychecks in{" "}
                <Link href="/finance/funds" className="underline">
                  Funds &amp; reserve
                </Link>
                .
              </p>
            )}
          </Card>
          {o.issues.length ? (
            <Card className="lg:col-span-2">
              <SectionHeader label="To look at" />
              <ul className="mt-2 space-y-1 text-sm">
                {o.issues.slice(0, 8).map((i) => (
                  <li key={`${i.code}:${i.ref ?? ""}`} className="flex gap-2">
                    <Pill tone={i.blocking ? "bad" : "wn"}>{i.blocking ? "Must fix" : "Warning"}</Pill>
                    <span>{i.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {o.funds.length ? (
            <Card>
              <SectionHeader label="Funds" />
              <ul className="mt-2 space-y-1 text-sm">
                {o.funds.map((f) => (
                  <li key={f.fundId} className="flex justify-between gap-2">
                    <span>
                      {f.name} {f.protected ? <Pill>Protected</Pill> : null}
                    </span>
                    <Money value={f.available} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      )}
      {o.lastRun ? (
        <p className="text-sm text-muted">
          Last {o.lastRun.kind === "monarch" ? "refresh" : o.lastRun.kind === "csv" ? "import" : "balance entry"}: {o.lastRun.status}
          {o.lastRun.error ? ` (${o.lastRun.error})` : ""}, {relativeTime(o.lastRun.at)}.
        </p>
      ) : null}
    </div>
  );
}
