"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dot, EmptyState, SectionHeader, useNow, type KTone } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { api } from "@/lib/client/api";
import type { RunEvent } from "@/lib/cw-runs";
import { childrenOf, groupRuns, type CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import { isOldFailure } from "@/lib/coordinator/status";
import { sameLabel } from "@/lib/chat/display";
import { ageLabel } from "@/lib/coordinator/needs";
import { relativeTime } from "@/lib/time";
import { useCoordinatorRuns, useMarkLooked, useResumeAll } from "./useCoordinatorRuns";

type Props = {
  onSteer: (ref: string, title: string) => void;
  onCommand: (text: string) => void;
  initialRef?: string;
  /** Other activity is listed below this panel: say "no runs" in one quiet line instead of a full empty state. */
  quietEmpty?: boolean;
};
const toneOf = (run: CoordinatorRunRow): KTone =>
  run.state === "failed" ? "bad" : run.stalled || run.state === "waiting" || run.state === "interrupted" ? "wn" : run.state === "done" ? "ok" : "ai";
const commandFor = (run: CoordinatorRunRow) => `${run.state === "failed" ? "Retry" : "Resume"} ${run.ref} (${run.title}).`;
/** What is happening, in words: the state and how long ago, never a bare enum. */
function stateLine(run: CoordinatorRunRow): string {
  const ago = relativeTime(run.updatedAt);
  if (run.state === "failed") return `Failed ${ago}`;
  if (run.state === "interrupted") return `Interrupted ${relativeTime(run.interruptedAt ?? run.updatedAt)}`;
  if (run.state === "waiting") return `Waiting since ${ago}`;
  if (run.state === "done") return `Finished ${relativeTime(run.finishedAt ?? run.updatedAt)}`;
  // A quiet run is not a failed run: say what is known (how long since it last reported), in amber, not red.
  return run.stalled ? `No update for ${ageLabel(run.updatedAt, Date.now())}` : `Working · updated ${ago}`;
}
const SECTIONS = [
  ["attention", "Stuck"],
  ["waiting", "Waiting on you"],
  ["interrupted", "Interrupted"],
  ["running", "Working"],
  ["done", "Finished since you looked"],
] as const;

export function RunningPanel({ onSteer, onCommand, initialRef, quietEmpty }: Props) {
  const query = useCoordinatorRuns();
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
  const groups = { ...grouped, attention: grouped.attention.filter((r) => !older.includes(r)) };
  const [showOlder, setShowOlder] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const rowProps = { runs: runs ?? [], onSteer, onCommand, initialRef, stopping, onStopping: setStopping };
  const ordered = [...groups.attention, ...groups.waiting, ...groups.interrupted, ...groups.running, ...groups.done, ...older];
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
      onSteer(run.ref, run.title);
    } else if (event.key === "x") {
      event.preventDefault();
      if (run.state === "running" || run.state === "waiting") setStopping(run.ref);
    } else if (event.key === "r" && ["failed", "waiting", "interrupted"].includes(run.state)) {
      event.preventDefault();
      onCommand(commandFor(run));
    } else if (event.key === "Enter" && target === body) {
      event.preventDefault();
      body.click();
    }
  };
  return (
    <div className="gc-running" ref={root} tabIndex={0} aria-label="Runs" onKeyDown={onKeyDown}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {query.isLoading ? <p className="text-muted">Loading runs…</p> : null}
      {resumeNote ? (
        <p className="text-sm text-muted" data-dynamic>
          {resumeNote}
        </p>
      ) : null}
      {query.error ? (
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
              <RunRow key={run.id} run={run} {...rowProps} />
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
            older.map((run) => <RunRow key={run.id} run={run} {...rowProps} />)
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

function RunRow({
  run,
  runs,
  onSteer,
  onCommand,
  initialRef,
  stopping,
  onStopping,
  ancestors = [],
}: Omit<Props, "quietEmpty"> & {
  run: CoordinatorRunRow;
  runs: CoordinatorRunRow[];
  stopping: string | null;
  onStopping: (ref: string | null) => void;
  ancestors?: string[];
}) {
  const childRuns = childrenOf(runs, run.id).filter((r) => !ancestors.includes(r.id) && r.id !== run.id);
  const descendantSelected = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return childrenOf(runs, id).some((child) => child.ref === initialRef || descendantSelected(child.id, seen));
  };
  const [expanded, setExpanded] = useState(run.ref === initialRef || (!!initialRef && descendantSelected(run.id)));
  const confirmStop = stopping === run.ref;
  const setConfirmStop = (on: boolean) => onStopping(on ? run.ref : null);
  const detailId = useId();
  const body = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (initialRef === run.ref) body.current?.focus();
  }, [initialRef, run.ref]);
  const events = useQuery({
    queryKey: ["work", "coordinator", "runs", run.ref, "events"],
    queryFn: ({ signal }) => api.get<{ events: RunEvent[] }>(`/api/coordinator/runs/${encodeURIComponent(run.ref)}/events`, signal),
    enabled: expanded,
  });
  const state = run.stalled ? "stalled" : run.state;
  const canStop = run.state === "running" || run.state === "waiting";
  const canRetry = ["failed", "waiting", "interrupted"].includes(run.state);
  const summary = run.lastEvent?.summary || run.summary || "";
  return (
    <article className="gc-run-row" data-run-ref={run.ref} data-state={state}>
      <div className="gc-run-heading">
        <Button
          ref={body}
          variant="ghost"
          className="gc-run-body"
          data-run-body={run.ref}
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded((open) => !open)}
        >
          <span className="gc-run-title">
            <Dot tone={toneOf(run)} live={run.state === "running" && !run.stalled} label={state} />
            <span className="min-w-0 flex-1 line-clamp-2">{run.title}</span>
            <ChevronIcon className={`gc-run-chevron h-4 w-4 ${expanded ? "-rotate-90" : "rotate-90"}`} />
          </span>
          <span className="gc-run-meta">
            <span data-tone={toneOf(run) === "bad" ? "bad" : run.stalled ? "warn" : undefined}>{stateLine(run)}</span>
            <span>{run.profile}</span>
            <span className="gc-ref" role="img" aria-label={`Run ${run.ref.replace("-", " ")}`}>
              {run.ref}
            </span>
            {run.noticeCount ? <span>{run.noticeCount === 1 ? "1 notice" : `${run.noticeCount} notices`}</span> : null}
          </span>
          {summary && !sameLabel(summary, run.title) ? <span className="gc-run-summary line-clamp-2">{summary}</span> : null}
          {run.pipeline.length ? (
            <span className="gc-run-pipeline" role="img" aria-label={`Pipeline: ${run.pipeline.map((p) => `${p.stage} ${p.state}`).join(", ")}`}>
              {run.pipeline.map((p) => (
                <span key={p.stage} className={`gc-run-stage gc-run-stage-${p.state}`} title={`${p.stage} ${p.state}`} aria-hidden="true">
                  {p.stage}
                </span>
              ))}
            </span>
          ) : null}
          {run.lock ? <span className="gc-run-lock">{run.lock.mode === "waits" ? `Waiting for ${run.lock.name}` : `Holds ${run.lock.name} lock`}</span> : null}
        </Button>
        <div className="gc-run-actions">
          {canRetry ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${run.state === "failed" ? "Retry" : "Resume"} ${run.ref}`}
              onClick={() => onCommand(commandFor(run))}
            >
              {run.state === "failed" ? "Retry" : "Resume"}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" aria-label={`Steer ${run.ref}`} onClick={() => onSteer(run.ref, run.title)}>
              Steer
            </Button>
          )}
        </div>
      </div>
      {confirmStop ? (
        <div role="group" aria-label={`Stop ${run.ref} and its sub-agents?`} className="gc-run-confirm">
          <p>Ask the Chief of staff to stop {run.ref} and its sub-agents? This writes the request in Chat for you to send; nothing stops until you send it.</p>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              onCommand(`Stop ${run.ref} (${run.title}) and its sub-agents.`);
              setConfirmStop(false);
            }}
          >
            Write stop request
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {expanded ? (
        <div className="gc-run-log" id={detailId}>
          <div className="gc-run-more">
            {canRetry ? (
              <Button size="sm" variant="ghost" aria-label={`Steer ${run.ref}`} onClick={() => onSteer(run.ref, run.title)}>
                Ask about this run
              </Button>
            ) : null}
            {canStop ? (
              <Button size="sm" variant="ghost" aria-label={`Stop ${run.ref}`} onClick={() => setConfirmStop(true)}>
                Ask to stop
              </Button>
            ) : null}
          </div>
          {events.isLoading ? <p>Loading log…</p> : null}
          {events.error ? (
            <p role="alert">
              Couldn&apos;t load log.{" "}
              <Button size="sm" variant="ghost" onClick={() => void events.refetch()}>
                Retry log
              </Button>
            </p>
          ) : null}
          {events.isSuccess && !events.data.events.length ? <p className="text-muted">No events yet.</p> : null}
          <ol aria-label={`Events for ${run.ref}`}>
            {events.data?.events.map((event) => (
              <li key={event.id}>
                <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> · {event.type} ·{" "}
                {event.summary}
              </li>
            ))}
          </ol>
          {run.prUrl && /^https:\/\/[^\s]+$/i.test(run.prUrl) ? (
            <a className="gc-run-pr" href={run.prUrl} target="_blank" rel="noopener noreferrer">
              Open pull request
            </a>
          ) : null}
          {childRuns.length ? (
            <section aria-label={`Sub-runs of ${run.ref}`}>
              <SectionHeader label="Sub-runs" count={childRuns.length} />
              {childRuns.map((child) => (
                <RunRow
                  key={child.id}
                  run={child}
                  runs={runs}
                  onSteer={onSteer}
                  onCommand={onCommand}
                  initialRef={initialRef}
                  stopping={stopping}
                  onStopping={onStopping}
                  ancestors={[...ancestors, run.id]}
                />
              ))}
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
