"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { EMPTY_AWAY, useAway } from "@/lib/client/away";
import type { AwayDigest, AwayRun } from "@/lib/away";
import { Button, ChipButton, Dot, Pill, useToast } from "@/components/ui";

const linkCls = "inline-flex min-h-11 min-w-0 items-center text-[var(--ai)] underline-offset-2 hover:underline sm:min-h-10 dense:min-h-6";

export function WhileAwayCard({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const q = useAway();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  if (!q.data?.runs?.length) return null;
  const counts = q.data.counts;
  const dismiss = async () => {
    setBusy(true);
    await qc.cancelQueries({ queryKey: ["away"] });
    const previous = qc.getQueryData<AwayDigest>(["away"]);
    qc.setQueryData(["away"], EMPTY_AWAY);
    try {
      await api.post("/api/agents/away/dismiss");
      toast("Hidden until the next run");
    } catch (error) {
      qc.setQueryData(["away"], previous);
      toast((error as Error).message, "danger");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["away"] });
    }
  };
  return (
    <section aria-labelledby={id} className={`k-card @container min-w-0 [overflow-wrap:anywhere] ${compact ? "mb-2" : "mb-4"}`} data-testid="while-away">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <h2 id={id} className="min-w-0 flex-1 text-sm font-semibold">
          While you were away
        </h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="×"
          className="min-h-11 min-w-11 sm:min-h-10 sm:min-w-10 dense:min-h-6 dense:min-w-6"
          aria-label="Dismiss while you were away"
          disabled={busy}
          onClick={() => void dismiss()}
        >
          Dismiss
        </Button>
        <div className="flex w-full flex-wrap gap-1" data-dynamic>
          {counts.ran > 0 ? <Pill tone="ai">{counts.ran} ran</Pill> : null}
          {counts.changes > 0 ? (
            <Pill tone="ai">
              {counts.changes} {counts.changes === 1 ? "change" : "changes"}
            </Pill>
          ) : null}
          {counts.needsYou > 0 ? (
            <Pill tone="wn">
              {counts.needsYou} {counts.needsYou === 1 ? "needs you" : "need you"}
            </Pill>
          ) : null}
          {counts.failed > 0 ? <Pill tone="bad">{counts.failed} failed</Pill> : null}
        </div>
      </header>
      <ul className="divide-y divide-line">
        {[...q.data.runs]
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
      </ul>
    </section>
  );
}

function RunRow({ run }: { run: AwayRun }) {
  const [expanded, setExpanded] = useState(false);
  const changesId = useId();
  const needs = run.decisions.filter((d) => d.open).length;
  const waiting = !!run.waiting;
  const tone = run.status === "failed" ? "bad" : needs || waiting ? "wn" : run.status === "skipped" ? "neutral" : "ai";
  return (
    <li className="min-w-0 px-3 py-2 text-sm" data-testid="away-run">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Dot
          tone={tone}
          live={run.status === "running" && !waiting}
          label={
            run.status === "failed"
              ? "Failed"
              : waiting
                ? "Needs you"
                : run.status === "running"
                  ? "Running"
                  : needs
                    ? "Needs you"
                    : run.status === "skipped"
                      ? "Skipped"
                      : "Done"
          }
        />
        <h3 className="min-w-0 font-semibold">{run.jobTitle}</h3>
        {run.areaTitle ? <span className="text-xs text-muted">{run.areaTitle}</span> : null}
        <time className="text-xs text-muted" dateTime={run.startedAt} data-dynamic>
          {new Date(run.startedAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
        </time>
      </div>
      <p className={`mt-1 line-clamp-2 ${run.silent ? "text-muted" : run.status === "failed" ? "text-danger" : "text-text"}`}>
        {run.silent
          ? "Nothing new"
          : waiting
            ? "Waiting for your approval. Open the report to answer it."
            : run.error || run.summary || (run.status === "running" ? "Running now. Results will appear here." : "Report ready")}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 text-xs">
        {run.sessionId ? (
          <Link className={linkCls} href={`/chat/${encodeURIComponent(run.sessionId)}`}>
            Open report
          </Link>
        ) : null}
        {run.changes.length ? (
          <ChipButton type="button" className={linkCls} aria-expanded={expanded} aria-controls={changesId} onClick={() => setExpanded(!expanded)} data-dynamic>
            {run.changes.length} {run.changes.length === 1 ? "change" : "changes"}
          </ChipButton>
        ) : null}
        {needs ? (
          <Link className={`${linkCls} !text-warn`} href="/decisions" data-dynamic>
            {needs} {needs === 1 ? "needs you" : "need you"}
          </Link>
        ) : null}
      </div>
      {expanded ? (
        <ul id={changesId} className="space-y-1 border-l border-[var(--aib)] pl-2">
          {run.changes.map((change, i) => (
            <li key={i}>
              {change.itemId ? (
                <Link className={linkCls} href={`/areas?item=${encodeURIComponent(change.itemId)}`}>
                  {change.label}
                </Link>
              ) : (
                <span>{change.label}</span>
              )}
              <span className="ml-1 text-xs text-muted">by @{run.profile ?? "coordinator"}</span>
            </li>
          ))}
          <li>
            <Link className={linkCls} href="/areas/activity">
              Review changes and Undo
            </Link>
          </li>
        </ul>
      ) : null}
      {run.refused.map((refused, i) => (
        <p key={i} className="mt-1 text-xs text-muted">
          Skipped: {refused.intent} ({refused.intent === "deploy" ? "Jarvis never deploys" : refused.label})
        </p>
      ))}
    </li>
  );
}
