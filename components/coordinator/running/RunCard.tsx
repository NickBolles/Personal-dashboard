"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, ButtonLink, Dot, Input, Pill, ProgressBar, SectionHeader, useNow } from "@/components/ui";
import { AreasIcon, ChatIcon, ChevronIcon, ExternalIcon, InboxIcon, RetryIcon, SteerIcon, StopIcon } from "@/components/icons";
import { api } from "@/lib/client/api";
import { STALL_AFTER_MIN } from "@/lib/agent-runs";
import { isActiveExec, type ExecutionRecord } from "@/lib/chat-execution";
import { plainMessageLine } from "@/lib/chat/display";
import type { Decision } from "@/lib/cw-decisions";
import type { RunEvent } from "@/lib/cw-runs";
import { canControl, steerText, stopText } from "@/lib/coordinator/control";
import { ageLabel } from "@/lib/coordinator/needs";
import {
  eventChip,
  eventClock,
  eventText,
  runAsk,
  runStatus,
  syncLine,
  tidyOutcome,
  timelineOf,
  type BackgroundWork,
  type CardTone,
} from "@/lib/coordinator/run-card";
import { childrenOf, type CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import { relativeTime } from "@/lib/time";
import "./run-card.css";

/** How many events an open card shows before "Show earlier". */
const PREVIEW = 3;

/** The state of a piece of work as a tinted chip (dot + one or two words), then how long, in plain text. */
export function StatusChip({ tone, live, label, detail, dotLabel }: { tone: CardTone; live?: boolean; label: string; detail?: string; dotLabel?: string }) {
  return (
    <span className="rc-status">
      <span className={`rc-chip k-t-${tone}`}>
        <Dot tone={tone} live={live} label={dotLabel} />
        {label}
      </span>
      {detail ? (
        <span className="rc-status-detail" data-dynamic>
          {detail}
        </span>
      ) : null}
    </span>
  );
}

/**
 * How current the cards are: "Synced just now", or, when a refresh fails, when what is on screen was last good,
 * with Retry on the same line. It describes fetching, never whether an agent is working.
 */
export function LiveLine({ updatedAt, failed, fetching, onRetry }: { updatedAt: number; failed?: boolean; fetching?: boolean; onRetry?: () => void }) {
  const now = useNow(10_000);
  const text = syncLine(updatedAt, !!failed, now);
  if (!text) return null;
  return (
    <p className="rc-live" data-state={failed ? "failed" : "live"} data-dynamic>
      <Dot tone={failed ? "wn" : "ok"} />
      <span>{text}</span>
      {failed && onRetry ? (
        <Button size="sm" variant="ghost" className="rc-live-retry" loading={fetching} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </p>
  );
}

/** Events as a real timeline: newest first, a tinted node and type chip per event, the time on the right. */
export function RunTimeline({ events, runTitle, label }: { events: readonly RunEvent[]; runTitle: string; label: string }) {
  const now = useNow();
  return (
    <ol className="rc-timeline" aria-label={label}>
      {events.map((event, index) => {
        const chip = eventChip(event);
        const text = eventText(event, runTitle);
        return (
          <li key={event.id} className={`rc-event k-t-${chip.tone}`} data-latest={index === 0 || undefined}>
            <span className="rc-node" aria-hidden="true" />
            <span className="rc-event-main">
              <Pill tone={chip.tone} className="rc-event-chip">
                {chip.label}
              </Pill>
              {text ? <span className="rc-event-text">{text}</span> : null}
            </span>
            <time className="rc-event-time" dateTime={event.at} title={new Date(event.at).toLocaleString()} data-dynamic>
              {eventClock(event.at, now)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

function Pipeline({ run }: { run: CoordinatorRunRow }) {
  if (!run.pipeline.length) return null;
  return (
    <span className="rc-pipeline" role="img" aria-label={`Pipeline: ${run.pipeline.map((p) => `${p.stage} ${p.state}`).join(", ")}`}>
      {run.pipeline.map((p) => (
        <span key={p.stage} className="rc-stage" data-state={p.state} title={`${p.stage} ${p.state}`} aria-hidden="true">
          {p.stage}
        </span>
      ))}
    </span>
  );
}

/** The one guidance field both kinds of card use: type what it should do differently, Send. */
function SteerField({
  label,
  pending,
  onSend,
  onClose,
}: {
  label: string;
  pending: boolean;
  onSend: (guidance: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [guidance, setGuidance] = useState("");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector("input")?.focus();
  }, []);
  return (
    <form
      ref={form}
      className="rc-steer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!guidance.trim() || pending) return;
        void onSend(guidance)
          .then(() => {
            setGuidance("");
            onClose();
          })
          .catch(() => undefined);
      }}
    >
      <Input
        aria-label={label}
        className="min-w-0 flex-1"
        placeholder="What should it do differently?"
        value={guidance}
        maxLength={2000}
        onChange={(event) => setGuidance(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={!guidance.trim()} loading={pending}>
        Send
      </Button>
    </form>
  );
}

export type RunCardProps = {
  run: CoordinatorRunRow;
  runs: readonly CoordinatorRunRow[];
  /** Recent events for every listed run (from the runs list itself), so a card has a timeline before it is opened. */
  events: readonly RunEvent[];
  /** Open decisions: a run waiting on the owner says which one. */
  decisions?: readonly Decision[];
  /**
   * With guidance: send it to the run now (resolves once sent or written into Chat). Without: open Chat with a
   * blank steering line (the keyboard shortcut, and "Ask" on a run that has stopped).
   */
  onSteer: (ref: string, title: string, guidance?: string) => void | Promise<unknown>;
  onCommand: (text: string) => void;
  /** Jump to a decision (D-n). */
  onRef?: (ref: string) => void;
  initialRef?: string;
  stopping: string | null;
  onStopping: (ref: string | null) => void;
  /** Open on arrival (the run that most needs the owner); every card can be opened by its header. */
  defaultOpen?: boolean;
  ancestors?: string[];
};
export const runCommand = (run: CoordinatorRunRow) => `${run.state === "failed" ? "Retry" : "Resume"} ${run.ref} (${run.title}).`;

/**
 * One run, readable without opening anything: what state it is in, what it needs when it is waiting, who is on
 * it, where its pipeline stands and the last thing it reported. Opened, it shows its recent timeline, its
 * sub-runs and what you can do about it.
 */
export function RunCard({
  run,
  runs,
  events,
  decisions = [],
  onSteer,
  onCommand,
  onRef,
  initialRef,
  stopping,
  onStopping,
  defaultOpen = false,
  ancestors = [],
}: RunCardProps) {
  const now = useNow();
  const status = runStatus(run, now);
  const childRuns = childrenOf(runs, run.id).filter((r) => !ancestors.includes(r.id) && r.id !== run.id);
  const descendantSelected = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return childrenOf(runs, id).some((child) => child.ref === initialRef || descendantSelected(child.id, seen));
  };
  const [open, setOpen] = useState(defaultOpen || run.ref === initialRef || (!!initialRef && descendantSelected(run.id)));
  const [all, setAll] = useState(false);
  const [steering, setSteering] = useState(false);
  const [sending, setSending] = useState(false);
  const confirmStop = stopping === run.ref;
  const detailId = useId();
  const head = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (initialRef === run.ref) head.current?.focus();
  }, [initialRef, run.ref]);
  const full = useQuery({
    queryKey: ["work", "coordinator", "runs", run.ref, "events"],
    queryFn: ({ signal }) => api.get<{ events: RunEvent[] }>(`/api/coordinator/runs/${encodeURIComponent(run.ref)}/events`, signal),
    enabled: open,
    refetchInterval: open && status.live ? 10_000 : false,
  });
  const known = timelineOf(
    events.filter((e) => e.runId === run.id),
    run.lastEvent ? [run.lastEvent] : undefined,
    full.data?.events,
  );
  // Closed: the newest event that says something (a bare "Done" or "Started" under the same chip says nothing new).
  const latest = known.find((e) => eventText(e, run.title)) ?? null;
  const shown = open ? (all ? known : known.slice(0, PREVIEW)) : latest ? [latest] : [];
  const hidden = known.length - shown.length;
  const canStop = run.state === "running" || run.state === "waiting";
  const canRetry = ["failed", "waiting", "interrupted"].includes(run.state);
  const ask = run.state === "waiting" ? runAsk(run, decisions) : null;
  // What the run itself last summarised: the outcome of a finished run, or all there is when it has sent no events.
  const summary = tidyOutcome(run.summary);
  const outcome =
    summary && eventText({ summary }, run.title) && (run.state === "done" || !latest) && summary !== (latest ? eventText(latest, run.title) : "")
      ? summary
      : "";
  const prUrl = run.prUrl && /^https:\/\/[^\s]+$/i.test(run.prUrl) ? run.prUrl : null;
  return (
    <article className="rc" data-run-ref={run.ref} data-state={status.key} data-open={open || undefined}>
      <Button
        ref={head}
        variant="ghost"
        className="gc-run-body rc-head"
        data-run-body={run.ref}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="rc-top">
          <StatusChip tone={status.tone} live={status.live} label={status.label} detail={status.detail} dotLabel={status.key} />
          <span className="gc-ref rc-ref" role="img" aria-label={`Run ${run.ref.replace("-", " ")}`}>
            {run.ref}
          </span>
          <ChevronIcon className={`rc-chevron h-4 w-4 ${open ? "-rotate-90" : "rotate-90"}`} />
        </span>
        <span className="rc-title line-clamp-2">{run.title}</span>
        <span className="rc-meta">
          <span>{run.profile}</span>
          {run.itemTitle && run.itemTitle !== run.title ? <span className="rc-meta-item">{run.itemTitle}</span> : null}
          {run.noticeCount ? <span>{run.noticeCount === 1 ? "1 step reported" : `${run.noticeCount} steps reported`}</span> : null}
          {childRuns.length ? <span>{childRuns.length === 1 ? "1 sub-run" : `${childRuns.length} sub-runs`}</span> : null}
        </span>
      </Button>
      {ask ? (
        <p className="rc-ask">
          <span className="rc-ask-text">
            <span className="rc-ask-label">Needs you</span>
            {ask.question}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="rc-jump k-t-ac"
            icon={<InboxIcon className="h-3.5 w-3.5" />}
            disabled={!onRef}
            aria-label={`Answer decision ${ask.ref.replace("-", " ")}`}
            onClick={() => onRef?.(ask.ref)}
          >
            Answer {ask.ref}
          </Button>
        </p>
      ) : null}
      <Pipeline run={run} />
      {run.lock ? <p className="rc-lock">{run.lock.mode === "waits" ? `Waiting for ${run.lock.name}` : `Holds ${run.lock.name} lock`}</p> : null}
      {outcome ? <p className="rc-summary line-clamp-3">{outcome}</p> : null}
      {shown.length ? <RunTimeline events={shown} runTitle={run.title} label={`Events for ${run.ref}`} /> : null}
      {open ? (
        <div className="rc-more" id={detailId}>
          {hidden > 0 || all ? (
            <Button
              size="sm"
              variant="ghost"
              className="rc-earlier"
              icon={<ChevronIcon className={`h-3 w-3 ${all ? "-rotate-90" : "rotate-90"}`} />}
              aria-expanded={all}
              onClick={() => setAll((value) => !value)}
            >
              {all ? "Show fewer" : `Show ${hidden} earlier`}
            </Button>
          ) : null}
          {full.isLoading && !known.length ? <p className="rc-note">Loading events…</p> : null}
          {full.error && !known.length ? (
            <p role="alert" className="rc-note">
              Couldn&apos;t load events.{" "}
              <Button size="sm" variant="ghost" onClick={() => void full.refetch()}>
                Try again
              </Button>
            </p>
          ) : null}
          {full.isSuccess && !known.length && !outcome ? <p className="rc-note">No events yet.</p> : null}
          {childRuns.length ? (
            <section aria-label={`Sub-runs of ${run.ref}`} className="rc-children">
              <SectionHeader label="Sub-runs" count={childRuns.length} />
              {childRuns.map((child) => (
                <RunCard
                  key={child.id}
                  run={child}
                  runs={runs}
                  events={events}
                  decisions={decisions}
                  onSteer={onSteer}
                  onCommand={onCommand}
                  onRef={onRef}
                  initialRef={initialRef}
                  stopping={stopping}
                  onStopping={onStopping}
                  ancestors={[...ancestors, run.id]}
                />
              ))}
            </section>
          ) : null}
          <div className="rc-actions">
            {canRetry ? (
              <Button
                size="sm"
                variant="ghost"
                className="rc-act"
                icon={<RetryIcon className="h-3.5 w-3.5" />}
                aria-label={`${run.state === "failed" ? "Retry" : "Resume"} ${run.ref}`}
                onClick={() => onCommand(runCommand(run))}
              >
                {run.state === "failed" ? "Retry" : "Resume"}
              </Button>
            ) : null}
            {canRetry ? (
              // A run that has stopped cannot be steered: this opens Chat with a line about it.
              <Button
                size="sm"
                variant="ghost"
                className="rc-act"
                icon={<ChatIcon className="h-3.5 w-3.5" />}
                aria-label={`Ask in chat about ${run.ref}`}
                onClick={() => void onSteer(run.ref, run.title)}
              >
                Ask in chat
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="rc-act"
                icon={<SteerIcon className="h-3.5 w-3.5" />}
                aria-label={`Steer ${run.ref}`}
                aria-expanded={steering}
                onClick={() => setSteering((value) => !value)}
              >
                Steer
              </Button>
            )}
            {prUrl ? (
              <ButtonLink size="sm" variant="ghost" className="rc-act" href={prUrl} external icon={<ExternalIcon className="h-3.5 w-3.5" />}>
                Pull request
              </ButtonLink>
            ) : null}
            {run.itemId ? (
              <ButtonLink
                size="sm"
                variant="ghost"
                className="rc-act"
                href={`/areas?item=${encodeURIComponent(run.itemId)}`}
                icon={<AreasIcon className="h-3.5 w-3.5" />}
              >
                Open item
              </ButtonLink>
            ) : null}
            {canStop ? (
              <Button
                size="sm"
                variant="ghost"
                className="rc-act rc-act-stop"
                icon={<StopIcon className="h-3.5 w-3.5" />}
                aria-label={`Ask to stop ${run.ref}`}
                onClick={() => onStopping(run.ref)}
              >
                Ask to stop
              </Button>
            ) : null}
          </div>
          {steering && !canRetry ? (
            <SteerField
              label={`Guidance for ${run.ref}`}
              pending={sending}
              onClose={() => setSteering(false)}
              onSend={async (guidance) => {
                setSending(true);
                try {
                  await onSteer(run.ref, run.title, guidance);
                } finally {
                  setSending(false);
                }
              }}
            />
          ) : null}
        </div>
      ) : null}
      {confirmStop ? (
        <div role="group" aria-label={`Stop ${run.ref} and its sub-agents?`} className="rc-confirm">
          <p>Ask the Chief of staff to stop {run.ref} and its sub-agents? This writes the request in Chat for you to send; nothing stops until you send it.</p>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              onCommand(`Stop ${run.ref} (${run.title}) and its sub-agents.`);
              onStopping(null);
            }}
          >
            Write stop request
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onStopping(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </article>
  );
}

const EXEC_STATUS: Record<ExecutionRecord["state"], { label: string; tone: CardTone }> = {
  running: { label: "Working", tone: "ai" },
  waiting: { label: "Waiting on you", tone: "wn" },
  completed: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Stopped", tone: "neutral" },
  unknown: { label: "No report yet", tone: "neutral" },
};
/** Longest outcome text shown before "More". */
const OUTCOME_CHARS = 180;

/**
 * Background work started from a conversation, as a card that answers "did it finish, fail or need me?" in place:
 * state chip, the current step or the outcome or error, progress when the source reports it, links, and Steer /
 * Ask to stop for a sub-agent that can take them. When the work is also a tracked run (R-n), that run's state and
 * latest events are what the card shows: one card per piece of work, one source of truth for its state.
 */
export function ExecCard({
  work,
  events = [],
  pending,
  onControl,
  children,
}: {
  work: BackgroundWork;
  events?: readonly RunEvent[];
  pending: boolean;
  onControl: (input: string) => Promise<unknown>;
  children?: ReactNode;
}) {
  const { record, run } = work;
  const [steering, setSteering] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [whole, setWhole] = useState(false);
  // A child discovered through the session list first keeps its child-session id as record id;
  // the coordinator steers/stops by Hermes' sub-agent handle (#251).
  const target = work.control ?? record;
  const handle = target.subagentId ?? target.id;
  const now = useNow();
  const tracked = run ? runStatus(run, now) : null;
  const active = tracked ? tracked.key === "working" || tracked.key === "stuck" || tracked.key === "waiting" : isActiveExec(record);
  const controllable = target.source === "subagent" && canControl(handle) && active;
  const at = record.updatedAt ?? record.endedAt ?? record.startedAt;
  // Same rule as Activity (lib/agent-runs.ts): "running" with no report for 30 minutes is stalled, not working.
  // Only a real heartbeat can go stale: a record that carries just its start time is not evidence of a stall.
  const stalled = !tracked && record.state === "running" && !!record.updatedAt && now - Date.parse(record.updatedAt) > STALL_AFTER_MIN * 60_000;
  const title = plainMessageLine(record.title).replace(/^Subagent:\s*/i, "");
  const status = tracked ?? (stalled ? { label: "Stuck", tone: "wn" as const } : EXEC_STATUS[record.state]);
  const detail = tracked ? tracked.detail : stalled ? `no update for ${ageLabel(record.updatedAt!, now)}` : at ? relativeTime(at, now) : "";
  const dotLabel = tracked ? tracked.key : stalled ? "stalled" : record.state;
  // What happened, in the source's own words: the error, else the step it is on, else how it ended.
  const said = tidyOutcome(record.error || (active ? record.step : null) || record.summary || record.step);
  const outcome =
    said ||
    (record.state === "unknown" && !tracked ? `${record.startedAt ? `Started ${relativeTime(record.startedAt, now)}` : "Started"} · hasn't reported yet.` : "");
  const long = outcome.length > OUTCOME_CHARS;
  const timeline = run
    ? timelineOf(
        events.filter((e) => e.runId === run.id),
        run.lastEvent ? [run.lastEvent] : undefined,
      )
        .filter((e) => eventText(e, record.title))
        .slice(0, 2)
    : [];
  const links = (record.links ?? []).filter((link) => /^https:\/\//i.test(link.url)).slice(0, 3);
  return (
    <article
      className="rc rc-exec"
      data-state={tracked ? tracked.key : stalled ? "stuck" : record.state}
      data-testid="coordinator-run-card"
      aria-label={record.title}
    >
      <div className="rc-top">
        <StatusChip
          tone={status.tone}
          live={tracked ? tracked.live : record.state === "running" && !stalled}
          label={status.label}
          detail={detail}
          dotLabel={dotLabel}
        />
        {run ? <span className="gc-ref rc-ref">{run.ref}</span> : null}
      </div>
      <p className="rc-title line-clamp-2" title={record.title}>
        {title}
      </p>
      {outcome && outcome.toLowerCase() !== title.toLowerCase() ? (
        <p className="rc-outcome" data-tone={record.error ? "bad" : undefined}>
          {record.error ? <span className="rc-outcome-label">Error</span> : null}
          <span>{whole || !long ? outcome : `${outcome.slice(0, OUTCOME_CHARS).trimEnd()}…`}</span>
          {long ? (
            <Button size="sm" variant="ghost" className="rc-earlier" aria-expanded={whole} onClick={() => setWhole((value) => !value)}>
              {whole ? "Less" : "More"}
            </Button>
          ) : null}
        </p>
      ) : null}
      {active && typeof record.progress === "number" ? (
        <div className="rc-progress">
          <ProgressBar value={record.progress * 100} tone="ai" label={`${Math.round(record.progress * 100)}% done`} />
        </div>
      ) : null}
      {timeline.length ? <RunTimeline events={timeline} runTitle={record.title} label={`Latest events for ${run!.ref}`} /> : null}
      {children}
      {record.href || links.length || controllable ? (
        <div className="rc-actions">
          {record.href ? (
            <ButtonLink size="sm" variant="ghost" className="rc-act" href={record.href} icon={<ChatIcon className="h-3.5 w-3.5" />}>
              Open
            </ButtonLink>
          ) : null}
          {links.map((link) => (
            <ButtonLink key={link.url} size="sm" variant="ghost" className="rc-act" href={link.url} external icon={<ExternalIcon className="h-3.5 w-3.5" />}>
              {link.label?.trim() || (link.kind === "github" ? "GitHub" : "Link")}
            </ButtonLink>
          ))}
          {controllable ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="rc-act"
                icon={<SteerIcon className="h-3.5 w-3.5" />}
                disabled={pending}
                aria-expanded={steering}
                onClick={() => setSteering((value) => !value)}
              >
                Steer
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="rc-act rc-act-stop"
                icon={<StopIcon className="h-3.5 w-3.5" />}
                disabled={pending}
                aria-expanded={confirmStop}
                onClick={() => setConfirmStop((value) => !value)}
              >
                Ask to stop
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {controllable && steering ? (
        <SteerField
          label={`Guidance for ${record.title}`}
          pending={pending}
          onClose={() => setSteering(false)}
          onSend={(guidance) => onControl(steerText(handle, guidance))}
        />
      ) : null}
      {controllable && confirmStop ? (
        <div role="group" aria-label={`Stop ${title}?`} className="rc-confirm">
          <p>Send a request to stop this sub-agent? It goes to the coordinator as soon as you confirm.</p>
          <Button
            size="sm"
            variant="danger"
            loading={pending}
            onClick={() =>
              void onControl(stopText(handle))
                .then(() => setConfirmStop(false))
                .catch(() => undefined)
            }
          >
            Send stop request
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </article>
  );
}
