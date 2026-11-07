"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { usd2 } from "@/lib/ai";
import { AGENT_SCOPE_LABELS } from "@/lib/agent-access";
import type { CoordinatorsResponse } from "@/lib/coordinator-settings";
import { Card, ErrorNote } from "@/components/ui";
import { EmptyState, ProgressBar, SectionHeader, Skeleton } from "@/components/ui/kit";
import { AgentMark } from "@/components/brand/AgentMark";

const LOCKED = ["Settle / archive / move", "Merges", "External writes", "Finance (never available to agents)"];
function Lock() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5 shrink-0">
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function CoordinatorsCard() {
  const q = useQuery({ queryKey: ["settings", "agents", "coordinators"], queryFn: () => api.get<CoordinatorsResponse>("/api/settings/agents/coordinators") });
  const b = q.data?.budget;
  return (
    <Card>
      <section aria-labelledby="coordinators-h" className="min-w-0">
        <SectionHeader id="coordinators-h" label="Coordinators" count={q.data?.coordinators.length} />
        {q.isPending ? (
          <div role="status" aria-label="Loading coordinators">
            <Skeleton />
            <Skeleton />
          </div>
        ) : null}
        {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
        {b ? (
          <div className="mb-3 space-y-1 text-sm">
            <p data-dynamic>
              Shared daily AI job budget: {usd2(b.spentUsd)} spent + {usd2(b.reservedUsd)} reserved / {usd2(b.budgetUsd)}
            </p>
            <ProgressBar tone="ai" value={b.budgetUsd > 0 ? ((b.spentUsd + b.reservedUsd) / b.budgetUsd) * 100 : 0} label="Shared daily AI job budget used" />
            <p className="text-xs text-muted">
              Job ledger only, not all chat or subscription usage. Profile meters below share this cap; they are not separate allowances.{" "}
              <Link href="/settings/ai" className="underline">
                AI &amp; budget
              </Link>
            </p>
          </div>
        ) : null}
        {q.data && !q.data.coordinators.length ? (
          <EmptyState title="No coordinators routed yet">Add a profile route below to see its coverage and policies.</EmptyState>
        ) : null}
        <ul className="divide-y divide-line">
          {q.data?.coordinators.map((c) => (
            <li key={c.profile} className="min-w-0 space-y-2 py-3 text-sm">
              <h3 className="flex min-w-0 items-center gap-2 font-semibold [overflow-wrap:anywhere]">
                <AgentMark name={c.profile} />@{c.profile}
              </h3>
              <dl className="space-y-2">
                <div>
                  <dt className="text-xs text-muted">Areas covered · configured profile</dt>
                  <dd className="flex flex-wrap gap-x-3 gap-y-1">
                    {c.areas.length
                      ? c.areas.map((a) => (
                          <Link className="tap underline [overflow-wrap:anywhere]" key={a.id} href={`/areas?item=${encodeURIComponent(a.id)}`}>
                            {a.title} · {a.agentMode}
                          </Link>
                        ))
                      : "No area assigned"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Mode</dt>
                  <dd>Not configured — Propose / Act on low-risk policy is not stored yet.</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">AI job spend · today / 7 days</dt>
                  <dd className="space-y-1" data-dynamic>
                    <p>
                      {usd2(c.spend.todayUsd)} / {usd2(c.spend.sevenDayUsd)} · {c.spend.jobs} jobs
                      {c.spend.estimatedJobs ? ` (${c.spend.estimatedJobs} estimated)` : ""}
                    </p>
                    <ProgressBar
                      tone="ai"
                      value={b && b.budgetUsd > 0 ? (c.spend.todayUsd / b.budgetUsd) * 100 : 0}
                      label={`${c.profile} today as a share of the shared daily cap`}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Schedule</dt>
                  <dd>No schedule yet — scheduled check-ins arrive with Autonomy.</dd>
                </div>
                <div>
                  <dt className="font-medium">Allowed without asking</dt>
                  <dd>
                    {c.scopes.length ? (
                      <ul className="list-inside list-disc">
                        {c.scopes.map((s) => (
                          <li key={s}>
                            {AGENT_SCOPE_LABELS[s].label} — {AGENT_SCOPE_LABELS[s].hint}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No active Jarvis access scopes granted.</p>
                    )}
                    <p className="mt-1 text-xs text-muted">Granted Jarvis token scopes only; not a promise about tools outside Jarvis.</p>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Always asks · locked</dt>
                  <dd>
                    <ul className="mt-1 space-y-1">
                      {LOCKED.map((p) => (
                        <li key={p} className="flex items-center gap-1.5">
                          <Lock />
                          {p}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
