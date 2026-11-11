"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, EmptyState, SectionHeader, useNow } from "@/components/ui";
import type { Decision } from "@/lib/cw-decisions";
import { groupRuns } from "@/lib/coordinator/runs-view";
import { isOldFailure } from "@/lib/coordinator/status";
import { byNeed } from "@/lib/coordinator/run-card";
import { LiveLine, RunCard, runCommand } from "./RunCard";
import { useCoordinatorRuns, useMarkLooked, useResumeAll } from "./useCoordinatorRuns";

type Props = {
  /** With guidance: send it (resolves when sent, or written into Chat when it cannot be sent). Without: open Chat on a blank steering line. */
  onSteer: (ref: string, title: string, guidance?: string) => void | Promise<unknown>;
  onCommand: (text: string) => void;
  /** Open decisions, so a run waiting on the owner says which one. */
  decisions?: readonly Decision[];
  /** Jump to a decision (D-n). */
  onRef?: (ref: string) => void;
  initialRef?: string;
  /** Other activity is listed below this panel: say "no runs" in one quiet line instead of a full empty state. */
  quietEmpty?: boolean;
};
/**
 * Only the run that most needs the owner arrives open (timeline and actions showing). Every other card is closed
 * and still says its state, what it needs and its latest event, so a phone screen holds an overview, not one card.
 */
const OPEN_ON_ARRIVAL = 1;
// What waits on the owner first, then what needs a look.
const SECTIONS = [
  ["waiting", "Waiting on you"],
  ["attention", "Stuck"],
  ["interrupted", "Interrupted"],
  ["running", "Working"],
  ["done", "Finished since you looked"],
] as const;

export function RunningPanel({ onSteer, onCommand, decisions, onRef, initialRef, quietEmpty }: Props) {
  const query = useCoordinatorRuns(true);
  const { mutate: markLooked } = useMarkLooked();
  const marked = useRef(false);
  const [visit, setVisit] = useState<{ since: string | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const seenFailures = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState("");
  const [confirmResume, setConfirmResume] = useState(false);
  const [resumeNote, setResumeNote] = useState("");
  const resumeAll = useResumeAll();
  const say = (text: string) => {
    setResumeNote(text);
    setAnnouncement(text);
  };
  const runs = query.data?.runs;
  useEffect(() => {
    if (!query.data || marked.current) return;
    marked.current = true;
    // Keep the old boundary for this visit; a successful mark must not erase Done.
    setVisit({ since: query.data.lastLooked.running });
    markLooked("running");
  }, [query.data, markLooked]);
  useEffect(() => {
    const failures = (runs ?? []).filter((r) => r.state === "failed" || r.stalled);
    const fresh = failures.filter((r) => !seenFailures.current.has(r.ref));
    failures.forEach((r) => seenFailures.current.add(r.ref));
    if (fresh.length) setAnnouncement(fresh.map((r) => `${r.ref} ${r.stalled ? "stalled" : "failed"}`).join(". "));
  }, [runs]);
  const now = useNow();
  const grouped = groupRuns(runs ?? [], visit ? visit.since : query.data?.lastLooked.running);
  // Failures older than a few days are history: reachable, but folded away from what is stuck now.
  const older = grouped.attention.filter((r) => isOldFailure(r, now) && r.ref !== initialRef);
  const groups = {
    ...grouped,
    attention: byNeed(
      grouped.attention.filter((r) => !older.includes(r)),
      query.data?.events ?? [],
    ),
  };
  const [showOlder, setShowOlder] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const rowProps = { runs: runs ?? [], events: query.data?.events ?? [], decisions, onSteer, onCommand, onRef, initialRef, stopping, onStopping: setStopping };
  const openFirst = new Set([...groups.waiting, ...groups.attention, ...groups.interrupted].slice(0, OPEN_ON_ARRIVAL).map((r) => r.id));
  const ordered = [...groups.waiting, ...groups.attention, ...groups.interrupted, ...groups.running, ...groups.done, ...older];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.altKey || event.ctrlKey || event.metaKey || target.closest("input, textarea, select, [contenteditable='true']")) return;
    const bodies = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-run-body]") ?? []);
    const current = bodies.findIndex((body) => body === target || body.closest("article") === target.closest("article"));
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      const next = current < 0 ? (event.key === "j" ? 0 : bodies.length - 1) : Math.max(0, Math.min(bodies.length - 1, current + (event.key === "j" ? 1 : -1)));
      bodies[next]?.focus();
      return;
    }
    const body = bodies[current];
    const run = (runs ?? []).find((r) => r.ref === body?.dataset.runBody);
    if (!run) return;
    if (event.key === "s") {
      event.preventDefault();
      void onSteer(run.ref, run.title);
    } else if (event.key === "x") {
      event.preventDefault();
      if (run.state === "running" || run.state === "waiting") setStopping(run.ref);
    } else if (event.key === "r" && ["failed", "waiting", "interrupted"].includes(run.state)) {
      event.preventDefault();
      onCommand(runCommand(run));
    } else if (event.key === "Enter" && target === body) {
      event.preventDefault();
      body.click();
    }
  };
  return (
    <div className="gc-running" ref={root} tabIndex={0} aria-label="Runs" data-stale={query.error && query.data ? "" : undefined} onKeyDown={onKeyDown}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {query.isLoading ? <p className="text-muted">Loading runs…</p> : null}
      {query.data ? <LiveLine updatedAt={query.dataUpdatedAt} failed={!!query.error} fetching={query.isFetching} onRetry={() => void query.refetch()} /> : null}
      {resumeNote ? (
        <p className="text-sm text-muted" data-dynamic>
          {resumeNote}
        </p>
      ) : null}
      {query.error && !query.data ? (
        <p role="alert">
          Couldn&apos;t load runs.{" "}
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
            Retry loading
          </Button>
        </p>
      ) : null}
      {query.isSuccess && !ordered.length ? (
        quietEmpty ? (
          <p className="gc-hint">No agent runs right now.</p>
        ) : (
          <EmptyState title="Nothing running">Work your agents start shows up here, with what is stuck first.</EmptyState>
        )
      ) : null}
      {SECTIONS.map(([key, label]) =>
        groups[key].length ? (
          <section key={key} aria-label={label}>
            <SectionHeader
              label={label}
              count={groups[key].length}
              action={
                key === "interrupted" ? (
                  <Button size="sm" variant="ghost" disabled={resumeAll.isPending} onClick={() => setConfirmResume(true)}>
                    Resume all {groups.interrupted.length}
                  </Button>
                ) : undefined
              }
            />
            {key === "interrupted" && confirmResume ? (
              <div role="group" aria-label={`Resume ${groups.interrupted.length} interrupted runs?`} className="gc-run-confirm">
                <p>Send a resume prompt to the session of {groups.interrupted.map((r) => r.ref).join(", ")}?</p>
                <Button
                  size="sm"
                  onClick={() => {
                    const refs = groups.interrupted.map((r) => r.ref);
                    setConfirmResume(false);
                    resumeAll.mutate(refs, {
                      onSuccess: ({ results }) => {
                        const sent = results.filter((r) => r.ok).map((r) => r.ref);
                        const failed = results.filter((r) => !r.ok).map((r) => r.ref);
                        say(
                          [sent.length ? `Resume sent for ${sent.join(", ")}` : "", failed.length ? `Couldn't resume ${failed.join(", ")}` : ""]
                            .filter(Boolean)
                            .join(". "),
                        );
                      },
                      onError: (error) => say(error instanceof Error ? error.message : "Couldn't resume. Try again."),
                    });
                  }}
                >
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmResume(false)}>
                  Cancel
                </Button>
              </div>
            ) : null}
            {groups[key].map((run) => (
              <RunCard key={run.id} run={run} defaultOpen={openFirst.has(run.id)} {...rowProps} />
            ))}
          </section>
        ) : null,
      )}
      {older.length ? (
        <section aria-label="Older failures">
          <SectionHeader
            label="Older failures"
            count={older.length}
            action={
              <Button size="sm" variant="ghost" aria-expanded={showOlder} onClick={() => setShowOlder((v) => !v)}>
                {showOlder ? "Hide" : "Show"}
              </Button>
            }
          />
          {showOlder ? (
            older.map((run) => <RunCard key={run.id} run={run} {...rowProps} />)
          ) : (
            <p className="gc-hint gc-older-preview">
              {older
                .slice(0, 2)
                .map((run) => run.title)
                .join(" · ")}
              {older.length > 2 ? ` · +${older.length - 2} more` : ""}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
