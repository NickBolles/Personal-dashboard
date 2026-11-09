"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dot, EmptyState, IconButton, Pill, SectionHeader, type KTone } from "@/components/ui";
import { ChatIcon, ChevronIcon, PanelIcon, StopIcon } from "@/components/icons";
import { api } from "@/lib/client/api";
import type { RunEvent } from "@/lib/cw-runs";
import { childrenOf, groupRuns, type CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import { relativeTime } from "@/lib/time";
import { useCoordinatorRuns, useMarkLooked, useResumeAll } from "./useCoordinatorRuns";

type Props = {
  onSteer: (ref: string, title: string) => void;
  onCommand: (text: string) => void;
  initialRef?: string;
};
const toneOf = (run: CoordinatorRunRow): KTone =>
  run.state === "failed" || run.stalled ? "bad" : run.state === "waiting" || run.state === "interrupted" ? "wn" : run.state === "done" ? "ok" : "ai";
const commandFor = (run: CoordinatorRunRow) => `${run.state === "failed" ? "Retry" : "Resume"} ${run.ref} (${run.title}).`;

export function RunningPanel({ onSteer, onCommand, initialRef }: Props) {
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
  const groups = groupRuns(runs ?? [], visit ? visit.since : query.data?.lastLooked.running);
  const ordered = [...groups.attention, ...groups.interrupted, ...groups.running, ...groups.done];
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
      body.closest("article")?.querySelector<HTMLButtonElement>("[data-stop]")?.click();
    } else if (event.key === "r" && ["failed", "waiting", "interrupted"].includes(run.state)) {
      event.preventDefault();
      onCommand(commandFor(run));
    } else if (event.key === "Enter" && target === body) {
      event.preventDefault();
      body.click();
    }
  };
  return (
    <div className="gc-running" ref={root} tabIndex={0} aria-label="Running runs" onKeyDown={onKeyDown}>
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
      {query.isSuccess && !ordered.length ? <EmptyState title="Nothing running" /> : null}
      {(
        [
          ["attention", "Needs attention"],
          ["interrupted", "Interrupted"],
          ["running", "Running"],
          ["done", "Done since you looked"],
        ] as const
      ).map(([key, label]) =>
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
              <RunRow key={run.id} run={run} runs={runs ?? []} onSteer={onSteer} onCommand={onCommand} initialRef={initialRef} />
            ))}
          </section>
        ) : null,
      )}
    </div>
  );
}

function RunRow({
  run,
  runs,
  onSteer,
  onCommand,
  initialRef,
  ancestors = [],
}: Props & { run: CoordinatorRunRow; runs: CoordinatorRunRow[]; ancestors?: string[] }) {
  const childRuns = childrenOf(runs, run.id).filter((r) => !ancestors.includes(r.id) && r.id !== run.id);
  const descendantSelected = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return childrenOf(runs, id).some((child) => child.ref === initialRef || descendantSelected(child.id, seen));
  };
  const [expanded, setExpanded] = useState(run.ref === initialRef || (!!initialRef && descendantSelected(run.id)));
  const [confirmStop, setConfirmStop] = useState(false);
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
  return (
    <article className="gc-run-row" data-run-ref={run.ref}>
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
            <span aria-label={`Run ${run.ref.replace("-", " ")}`}>
              <Pill tone={toneOf(run)}>{run.ref}</Pill>
            </span>
            <span className="min-w-0 flex-1 line-clamp-2">{run.title}</span>
          </span>
          <span className="gc-run-meta">
            <span>{run.profile}</span>
            <span aria-hidden="true"> · </span>
            <span className="gc-run-summary line-clamp-2">{run.lastEvent?.summary || run.summary || state}</span>
            <span aria-hidden="true"> · </span>
            <time dateTime={run.updatedAt}>{relativeTime(run.updatedAt)}</time>
            {run.pipeline.length ? (
              <span className="gc-run-pipeline" role="img" aria-label={`Pipeline: ${run.pipeline.map((p) => `${p.stage} ${p.state}`).join(", ")}`}>
                {run.pipeline.map((p) => (
                  <span key={p.stage} className={`gc-run-stage gc-run-stage-${p.state}`} title={`${p.stage} ${p.state}`} aria-hidden="true">
                    {p.stage}
                  </span>
                ))}
              </span>
            ) : null}
            {run.lock ? (
              <span className="gc-run-lock">{run.lock.mode === "waits" ? `Waiting for ${run.lock.name}` : `Holds ${run.lock.name} lock`}</span>
            ) : null}
            {run.noticeCount ? <span>{run.noticeCount} notices</span> : null}
          </span>
        </Button>
        <div className="gc-run-actions">
          <IconButton label={`Steer ${run.ref}`} icon={<ChatIcon className="h-4 w-4" />} onClick={() => onSteer(run.ref, run.title)} />
          {canStop ? <IconButton label={`Stop ${run.ref}`} data-stop icon={<StopIcon className="h-4 w-4" />} onClick={() => setConfirmStop(true)} /> : null}
          {["failed", "waiting", "interrupted"].includes(run.state) ? (
            <IconButton
              label={`${run.state === "failed" ? "Retry" : "Resume"} ${run.ref}`}
              icon={<ChevronIcon className="h-4 w-4" />}
              onClick={() => onCommand(commandFor(run))}
            />
          ) : null}
          <IconButton
            label={`Log ${run.ref}`}
            icon={<PanelIcon className="h-4 w-4" />}
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((open) => !open)}
          />
        </div>
      </div>
      {confirmStop ? (
        <div role="group" aria-label={`Stop ${run.ref} and its sub-agents?`} className="gc-run-confirm">
          <p>Stop {run.ref} and its sub-agents?</p>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              onCommand(`Stop ${run.ref} (${run.title}) and its sub-agents.`);
              setConfirmStop(false);
            }}
          >
            Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {expanded ? (
        <div className="gc-run-log" id={detailId}>
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
