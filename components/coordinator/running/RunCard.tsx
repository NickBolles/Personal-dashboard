"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AgentMark } from "@/components/brand/AgentMark";
import { Button, ButtonLink, Dot, Pill, ProgressBar, RefPill, RowAction, SectionHeader, StateWord, ThingRow, useNow, type ThingState } from "@/components/ui";
import { SummaryCard } from "../cards/SummaryCard";
import { AreasIcon, ChatIcon, ChevronIcon, ExternalIcon, LogIcon, RetryIcon, SteerIcon, StopIcon } from "@/components/icons";
import { api } from "@/lib/client/api";
import { STALL_AFTER_MIN } from "@/lib/agent-runs";
import { isActiveExec } from "@/lib/chat-execution";
import { plainMessageLine } from "@/lib/chat/display";
import type { Decision } from "@/lib/cw-decisions";
import type { RunEvent } from "@/lib/cw-runs";
import type { ComposeScope } from "@/lib/coordinator/compose";
import { canControl, stopText } from "@/lib/coordinator/control";
import { ageLabel } from "@/lib/coordinator/needs";
import {
  eventChip,
  eventAgo,
  eventText,
  runNeeds,
  runPulse,
  runStatus,
  cardStatus,
  syncLine,
  tidyOutcome,
  timelineOf,
  controlHandle,
  type BackgroundWork,
  type CardTone,
} from "@/lib/coordinator/run-card";
import { childrenOf, type CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import { relativeTime } from "@/lib/time";
import { WORK_WORD, workStateOfExec, workStateOfRun } from "@/lib/work-words";
import "./run-card.css";

/** How many events (ones that say something) an open card shows before "Show earlier". */
const PREVIEW = 3;

/** The state of a piece of work as a tinted chip (dot + one or two words), then how long, in plain text. */
export function StatusChip({
  tone,
  live,
  label,
  detail,
  dotLabel,
  agent,
  burst = 0,
  celebrate,
}: {
  tone: CardTone;
  live?: boolean;
  label: string;
  detail?: string;
  dotLabel?: string;
  /** Whose work this is: the chip then leads with that agent's mark (its arc turns while working) instead of a dot. */
  agent?: string;
  /** Bumped each time the state changes while on screen: the chip pops once per change. */
  burst?: number;
  /** With a burst: this change is good news (the work finished), so the pop comes with a few sparks. */
  celebrate?: boolean;
}) {
  return (
    <span className="rc-status">
      <span key={burst} className={`rc-chip k-t-${tone}${burst ? " k-pop" : ""}`}>
        {agent ? <AgentMark name={agent} busy={live} label={dotLabel} /> : <Dot tone={tone} live={live} label={dotLabel} />}
        {/* One live signal per chip: the mark's arc when there is a mark, else the shimmer. */}
        <span className={live && !agent ? "rc-shimmer" : undefined}>{label}</span>
        {burst && celebrate ? (
          <span className="k-spark" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <i key={i} style={{ "--a": `${i * 45}deg` } as CSSProperties} />
            ))}
          </span>
        ) : null}
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
 * How current the cards are: "Synced just now", or, when a refresh fails, how long ago what is on screen was
 * last good, with Retry on the same line. It describes fetching, never whether an agent is working.
 */
export function LiveLine({ updatedAt, failed, fetching, onRetry }: { updatedAt: number; failed?: boolean; fetching?: boolean; onRetry?: () => void }) {
  const now = useNow(10_000);
  const text = syncLine(updatedAt, !!failed, now);
  if (!text) return null;
  return (
    <p
      className="rc-live"
      data-state={failed ? "failed" : "live"}
      title={updatedAt ? `Last synced ${new Date(updatedAt).toLocaleTimeString()}` : undefined}
      data-dynamic
    >
      <span key={failed ? "failed" : updatedAt} className={failed ? undefined : "rc-sync"}>
        <Dot tone={failed ? "wn" : "ok"} />
      </span>
      <span>{text}</span>
      {failed && onRetry ? (
        <Button size="sm" variant="ghost" className="rc-live-retry" disabled={fetching} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </p>
  );
}

/** How long a live run's newest event keeps pulsing: after that the outline alone says the run is working. */
const FRESH_MS = 2 * 60_000;

/** Events as a real timeline: newest first, a tinted node and type chip per event, the time on the right. */
export function RunTimeline({ events, runTitle, label, live }: { events: readonly RunEvent[]; runTitle: string; label: string; live?: boolean }) {
  const now = useNow();
  // Anything reported after this timeline was first drawn is news: it slides in and glows once.
  const [since] = useState(() => Date.now());
  return (
    <ol className="rc-timeline" aria-label={label}>
      {events.map((event, index) => {
        const chip = eventChip(event);
        const text = eventText(event, runTitle);
        return (
          <li
            key={event.id}
            className={`rc-event k-t-${chip.tone}`}
            data-latest={index === 0 || undefined}
            data-live={(live && index === 0 && now - Date.parse(event.at) < FRESH_MS) || undefined}
            data-new={Date.parse(event.at) > since || undefined}
          >
            <span className="rc-node" aria-hidden="true" />
            <span className="rc-event-main">
              <Pill tone={chip.tone} className="rc-event-chip">
                {chip.label}
              </Pill>
              {text ? <span className="rc-event-text">{text}</span> : null}
            </span>
            <time className="rc-event-time" dateTime={event.at} title={new Date(event.at).toLocaleString()} data-dynamic>
              {eventAgo(event.at, now)}
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

const ic = "h-4 w-4";
const small = "h-3.5 w-3.5";

/** The state word of a row. While the work is live the word shimmers; when the state changes on screen it pops once. */
function RowState({ state, label, live, burst, celebrate }: { state: ThingState; label: string; live?: boolean; burst: number; celebrate?: boolean }) {
  const word = <span className={live ? "rc-shimmer" : undefined}>{label}</span>;
  return (
    <span key={burst} className={`rc-state${burst ? " k-pop" : ""}`}>
      {state === "idle" ? <span className="rc-state-idle">{word}</span> : <StateWord state={state}>{word}</StateWord>}
      {burst && celebrate ? (
        <span className="k-spark" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ "--a": `${i * 45}deg` } as CSSProperties} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** Line two of a row: the state word, then what is known, separated by middle dots. */
function SubLine({ state, parts }: { state: ReactNode; parts: (string | null | undefined | false)[] }) {
  return (
    <>
      {state}
      {parts.filter(Boolean).map((part, index) => (
        <span key={index} data-dynamic>
          {" "}
          · {part}
        </span>
      ))}
    </>
  );
}

export type RunCardProps = {
  run: CoordinatorRunRow;
  runs: readonly CoordinatorRunRow[];
  /** Recent events for every listed run (from the runs list itself), so a row has a timeline before it is opened. */
  events: readonly RunEvent[];
  /** Open decisions: a run waiting on the owner says which one. */
  decisions?: readonly Decision[];
  /** Put this run's chip in the one composer: steer it, reply to it, retry it or ask about it. Nothing is sent. */
  onCompose: (scope: ComposeScope) => void;
  /** Send the stop request for this run (after the owner confirmed in place). */
  onStop: (run: CoordinatorRunRow) => void | Promise<unknown>;
  /** Jump to a decision (D-n). */
  onRef?: (ref: string) => void;
  initialRef?: string;
  stopping: string | null;
  onStopping: (ref: string | null) => void;
  /** Open on arrival (a run that needs the owner); every row can be opened by its body. */
  defaultOpen?: boolean;
  ancestors?: string[];
};
export const steerScope = (run: CoordinatorRunRow): ComposeScope => ({ kind: run.state === "waiting" ? "reply" : "steer", ref: run.ref, title: run.title });
export const retryScope = (run: CoordinatorRunRow): ComposeScope => ({
  kind: "retry",
  ref: run.ref,
  title: run.title,
  verb: run.state === "failed" ? "Retry" : "Resume",
});
export const canRetryRun = (run: CoordinatorRunRow) => ["failed", "waiting", "interrupted"].includes(run.state);
export const canStopRun = (run: CoordinatorRunRow) => run.state === "running" || run.state === "waiting";

/**
 * One run as a row: its R-n and title, then its state in the shared words with what is known (what it waits for,
 * how long, who is on it). At most two icon actions, chosen by state. Opened in place, it shows what a card
 * would: what it needs, its pipeline, the last things it reported, its sub-runs and every other action.
 */
export function RunCard({
  run,
  runs,
  events,
  decisions = [],
  onCompose,
  onStop,
  onRef,
  initialRef,
  stopping,
  onStopping,
  defaultOpen = false,
  ancestors = [],
}: RunCardProps) {
  const now = useNow();
  const reported = runStatus(run, now);
  const childRuns = childrenOf(runs, run.id).filter((r) => !ancestors.includes(r.id) && r.id !== run.id);
  const descendantSelected = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return childrenOf(runs, id).some((child) => child.ref === initialRef || descendantSelected(child.id, seen));
  };
  const [open, setOpen] = useState(defaultOpen || run.ref === initialRef || (!!initialRef && descendantSelected(run.id)));
  const [all, setAll] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  // The state changed while this row was on screen (derived during render, so it costs no extra effect).
  const [shownState, setShownState] = useState(reported.key);
  const [burst, setBurst] = useState(() => (reported.key === "done" && !!run.finishedAt && Date.now() - Date.parse(run.finishedAt) < 30_000 ? 1 : 0));
  if (shownState !== reported.key) {
    setShownState(reported.key);
    setBurst((n) => n + 1);
  }
  const confirmStop = stopping === run.ref;
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (initialRef === run.ref) root.current?.querySelector<HTMLElement>("[data-run-body]")?.focus();
  }, [initialRef, run.ref]);
  const full = useQuery({
    queryKey: ["work", "coordinator", "runs", run.ref, "events"],
    queryFn: ({ signal }) => api.get<{ events: RunEvent[] }>(`/api/coordinator/runs/${encodeURIComponent(run.ref)}/events`, signal),
    enabled: open,
    refetchInterval: open && reported.live ? 10_000 : false,
  });
  const known = timelineOf(
    events.filter((e) => e.runId === run.id),
    run.lastEvent ? [run.lastEvent] : undefined,
    full.data?.events,
  );
  // Events that say something (a bare "Started" or "Done" under the same word adds nothing).
  const telling = known.filter((e) => eventText(e, run.title));
  const pulse = runPulse(run, known, now);
  const latest = telling[0] ?? null;
  // One rule for a failed step on every surface (lib/coordinator/run-card.ts cardStatus): a silent run whose
  // newest event reports a failed step. A failed step is not a failed run; the run's own state is unchanged.
  const status = cardStatus(run, known, now);
  const state = workStateOfRun(status.key);
  const shown = all ? known : telling.slice(0, PREVIEW);
  const hidden = known.length - shown.length;
  const waiting = run.state === "waiting";
  const canStop = canStopRun(run);
  const canRetry = canRetryRun(run);
  // A working run is steered and a waiting one is answered; one that has stopped can take neither.
  const canSteer = waiting || run.state === "running";
  const needs = runNeeds(run, decisions);
  const asks = needs?.decision ?? null;
  // What the run itself last summarised: the outcome of a finished run, or all there is when it has sent no events.
  const summary = tidyOutcome(run.summary);
  const outcome =
    summary &&
    summary !== needs?.text &&
    eventText({ summary }, run.title) &&
    (run.state === "done" || !latest) &&
    summary !== (latest ? eventText(latest, run.title) : "")
      ? summary
      : "";
  const prUrl = run.prUrl && /^https:\/\/[^\s]+$/i.test(run.prUrl) ? run.prUrl : null;
  const router = useRouter();
  const steer = () => onCompose(steerScope(run));
  const retry = () => onCompose(retryScope(run));
  const ask = () => onCompose({ kind: "ask", ref: run.ref, title: run.title });
  const retryWord = run.state === "failed" ? "Retry" : "Resume";
  // Everything this row can do, for a right-click or a long press: nothing is reachable only by opening it.
  const actions = [
    { label: `${run.ref} · ${status.label}`, heading: true },
    canSteer ? { label: waiting ? "Reply…" : "Steer…", onSelect: steer } : null,
    canRetry ? { label: waiting ? "Resume without replying" : retryWord, onSelect: retry } : null,
    { label: "Ask in chat", onSelect: ask },
    { label: open ? "Close log" : "Open log", onSelect: () => setOpen((value) => !value) },
    asks && onRef ? { label: `Review ${asks.ref}`, onSelect: () => onRef(asks.ref) } : null,
    run.itemId ? { label: "Open item", onSelect: () => router.push(`/areas?item=${encodeURIComponent(run.itemId)}`) } : null,
    prUrl ? { label: "Open pull request", onSelect: () => void window.open(prUrl, "_blank", "noopener,noreferrer") } : null,
    { label: `Copy ${run.ref}`, onSelect: () => void navigator.clipboard?.writeText(run.ref).catch(() => undefined) },
    canStop ? { label: "Stop…", danger: true, onSelect: () => onStopping(run.ref) } : null,
  ].filter((item) => item !== null);
  // The two icons that matter for this state, in the fixed order Steer, Stop, Retry, Log.
  const log = <RowAction label={`Log for ${run.ref}`} icon={<LogIcon className={ic} />} aria-expanded={open} onClick={() => setOpen((value) => !value)} />;
  const stopAction = (
    <RowAction
      label={`Stop ${run.ref}`}
      tone="danger"
      icon={<StopIcon className={ic} />}
      aria-expanded={confirmStop}
      onClick={() => onStopping(confirmStop ? null : run.ref)}
    />
  );
  const rowActions =
    status.key === "working" || status.key === "stuck" ? (
      <>
        <RowAction label={`Steer ${run.ref}`} icon={<SteerIcon className={ic} />} onClick={steer} />
        {stopAction}
      </>
    ) : status.key === "waiting" ? (
      asks && onRef ? (
        <RefPill id={asks.ref} onClick={() => onRef(asks.ref)} />
      ) : (
        <>
          <RowAction label={`Reply to ${run.ref}`} icon={<SteerIcon className={ic} />} onClick={steer} />
          {stopAction}
        </>
      )
    ) : status.key === "done" ? (
      log
    ) : (
      <>
        <RowAction label={`${retryWord} ${run.ref}`} icon={<RetryIcon className={ic} />} onClick={retry} />
        {log}
      </>
    );
  return (
    <SummaryCard
      ref={root}
      label={run.ref}
      actions={actions}
      trigger={false}
      className="rc-row"
      data-run-ref={run.ref}
      data-state={status.key}
      data-open={open || undefined}
      data-live={status.live || undefined}
    >
      <ThingRow
        state={state}
        refId={run.ref}
        title={run.title}
        tight={status.key === "done" && !open}
        sub={
          <SubLine
            state={<RowState state={state} label={status.label} live={status.live} burst={burst} celebrate={status.key === "done"} />}
            parts={[
              asks ? `answer ${asks.ref}` : null,
              status.detail,
              status.key === "done" ? null : run.profile,
              childRuns.length ? (childRuns.length === 1 ? "1 sub-run" : `${childRuns.length} sub-runs`) : null,
            ]}
          />
        }
        expanded={open}
        onOpen={() => setOpen((value) => !value)}
        hitProps={{ "data-run-body": run.ref, className: "k-thing-hit gc-run-body" }}
        actions={rowActions}
      >
        {needs ? (
          <p className="rc-ask">
            <span className="rc-ask-text">
              <span className="rc-ask-label">{WORK_WORD.needs}</span>
              {needs.text}
            </span>
          </p>
        ) : null}
        <p className="rc-meta">
          {run.itemTitle && run.itemTitle !== run.title ? <span className="rc-meta-item">{run.itemTitle}</span> : null}
          {run.noticeCount ? <span>{run.noticeCount === 1 ? "1 step reported" : `${run.noticeCount} steps reported`}</span> : null}
          <span data-dynamic>started {relativeTime(run.startedAt, now)}</span>
        </p>
        {pulse.length > 1 ? (
          <span className="rc-pulse-row">
            <span className="rc-pulse-label">Reports</span>
            <span
              className="rc-pulse"
              role="img"
              aria-label={`${pulse.length} reports since it started; the last one ${relativeTime(known[0]!.at, now)}`}
              title="When it reported, from its start to now"
            >
              {pulse.map((tick) => (
                <i key={tick.id} className={`k-t-${tick.tone}`} style={{ "--at": tick.at } as CSSProperties} />
              ))}
              {status.live ? <i className="rc-pulse-now" /> : null}
            </span>
            <span className="rc-pulse-label">{status.key === "done" ? "end" : "now"}</span>
          </span>
        ) : null}
        <Pipeline run={run} />
        {run.lock ? <p className="rc-lock">{run.lock.mode === "waits" ? `Waiting for ${run.lock.name}` : `Holds ${run.lock.name} lock`}</p> : null}
        {outcome ? <p className="rc-summary line-clamp-3">{outcome}</p> : null}
        {shown.length ? <RunTimeline events={shown} runTitle={run.title} label={`Events for ${run.ref}`} live={status.live} /> : null}
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
                onCompose={onCompose}
                onStop={onStop}
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
          {asks && canSteer ? (
            <Button
              size="sm"
              variant="ghost"
              className="rc-act"
              icon={<SteerIcon className={small} />}
              aria-label={`Reply to ${run.ref} in your own words`}
              onClick={steer}
            >
              Reply
            </Button>
          ) : null}
          {canRetry && waiting ? (
            <Button
              size="sm"
              variant="ghost"
              className="rc-act"
              icon={<RetryIcon className={small} />}
              aria-label={`Resume ${run.ref} without replying`}
              onClick={retry}
            >
              Resume
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="rc-act" icon={<ChatIcon className={small} />} aria-label={`Ask in chat about ${run.ref}`} onClick={ask}>
            Ask in chat
          </Button>
          {prUrl ? (
            <ButtonLink size="sm" variant="ghost" className="rc-act" href={prUrl} external icon={<ExternalIcon className={small} />}>
              Pull request
            </ButtonLink>
          ) : null}
          {run.itemId ? (
            <ButtonLink
              size="sm"
              variant="ghost"
              className="rc-act"
              href={`/areas?item=${encodeURIComponent(run.itemId)}`}
              icon={<AreasIcon className={small} />}
            >
              Open item
            </ButtonLink>
          ) : null}
          {canStop && asks ? (
            <Button
              size="sm"
              variant="ghost"
              className="rc-act rc-act-stop"
              icon={<StopIcon className={small} />}
              aria-label={`Stop ${run.ref}`}
              onClick={() => onStopping(run.ref)}
            >
              Stop
            </Button>
          ) : null}
        </div>
      </ThingRow>
      {confirmStop ? (
        <div role="group" aria-label={`Stop ${run.ref} and its sub-agents?`} className="rc-confirm">
          <p>Stop {run.ref} and its sub-agents? The request goes to the Chief of staff as soon as you confirm.</p>
          <Button
            size="sm"
            variant="danger"
            loading={stopBusy}
            onClick={() => {
              setStopBusy(true);
              void Promise.resolve(onStop(run))
                .then(() => onStopping(null))
                .catch(() => undefined)
                .finally(() => setStopBusy(false));
            }}
          >
            Stop {run.ref}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onStopping(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </SummaryCard>
  );
}

/** Longest outcome text shown before "More". */
const OUTCOME_CHARS = 180;

/**
 * Work a conversation started, as the same row: did it finish, fail or need the owner? Its state in the shared
 * words, the step it is on or how it ended, and at most two icon actions: Steer (or Reply) and Stop for a
 * sub-agent that can take them, Reply for work that failed or waits. When the work is also a tracked run (R-n),
 * that run's state and latest events are what the row shows. Steer and Reply put a chip in the one composer;
 * Stop asks once in place and then sends the request.
 */
export function ExecCard({
  work,
  events = [],
  pending,
  onControl,
  onCompose,
  children,
}: {
  work: BackgroundWork;
  events?: readonly RunEvent[];
  pending: boolean;
  /** Sends a one-line command to the conversation now (the confirmed stop request). */
  onControl: (input: string) => Promise<unknown>;
  /** Puts this work's chip in the composer (steer, reply, ask). Nothing is sent. */
  onCompose: (scope: ComposeScope) => void;
  children?: ReactNode;
}) {
  const { record, run } = work;
  const [stopAsked, setStopAsked] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const [shownState, setShownState] = useState(record.state);
  const [burst, setBurst] = useState(0);
  if (shownState !== record.state) {
    setShownState(record.state);
    setBurst((n) => n + 1);
  }
  // A child discovered through the session list first keeps its child-session id as record id;
  // the coordinator steers/stops by Hermes' sub-agent handle (#251).
  const target = work.control ?? record;
  const handle = controlHandle(target);
  const now = useNow();
  const tracked = run ? runStatus(run, now) : null;
  const active = tracked ? tracked.key === "working" || tracked.key === "stuck" || tracked.key === "waiting" : isActiveExec(record);
  const reachable = target.source === "subagent" && canControl(handle);
  // Both must be going: the run the row shows, and the sub-agent the controls would reach.
  const controllable = reachable && active && isActiveExec(target);
  // A sub-agent can outlive the tracked run it belongs to. The row shows the run's state, and the sub-agent that
  // is still going can still be steered or stopped.
  const lingering = reachable && !active && isActiveExec(target);
  const at = record.updatedAt ?? record.endedAt ?? record.startedAt;
  // Same rule as Activity (lib/agent-runs.ts): "running" with no report for 30 minutes has stalled.
  // Only a real heartbeat can go stale: a record that carries just its start time is not evidence of a stall.
  const stalled = !tracked && record.state === "running" && !!record.updatedAt && now - Date.parse(record.updatedAt) > STALL_AFTER_MIN * 60_000;
  const title = plainMessageLine(record.title).replace(/^Subagent:\s*/i, "");
  // Nothing is known yet: that is not "Working". The row says so in its own words and shows no state colour.
  const unknown = !tracked && record.state === "unknown";
  const state: ThingState = tracked ? workStateOfRun(tracked.key) : unknown ? "idle" : workStateOfExec(record.state, stalled);
  const label = unknown ? "No report yet" : WORK_WORD[state as Exclude<ThingState, "idle">];
  const detail = tracked ? tracked.detail : stalled ? `no report for ${ageLabel(record.updatedAt!, now)}` : at ? relativeTime(at, now) : "";
  const waiting = tracked ? tracked.key === "waiting" : record.state === "waiting";
  // What happened, in the source's own words: the error, else the step it is on, else how it ended.
  const said = tidyOutcome(record.error || (active ? record.step : null) || record.summary || record.step);
  const outcome = said || (unknown ? `${record.startedAt ? `Started ${relativeTime(record.startedAt, now)}` : "Started"} · hasn't reported yet.` : "");
  const tells = !!outcome && outcome.toLowerCase() !== title.toLowerCase();
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
  const isLive = tracked ? tracked.live : record.state === "running" && !stalled;
  // Work that failed cannot be steered, but it can be answered.
  const canReply = !controllable && (record.state === "failed" || waiting);
  const steerable = controllable || lingering;
  // While the tracked run is going, stopping asks the coordinator to stop the run and its sub-agents; once it has
  // ended there is nothing of it to stop, and the request goes to the sub-agent itself.
  const viaRun = !!run && active;
  const stoppable = steerable || (viaRun && reachable);
  // What confirming would do is fixed when the confirmation opens. If that changes under it (the run ends, or is
  // no longer this row's), it closes: a confirmation is for one action on one target.
  const stopOffer = !stoppable ? null : viaRun ? `run:${run!.id}` : `send:${handle}`;
  if (stopAsked !== null && stopAsked !== stopOffer) setStopAsked(null);
  const confirmStop = stopAsked !== null && stopAsked === stopOffer;
  const setConfirmStop = (open: boolean) => setStopAsked(open ? stopOffer : null);
  const hasMore = tells || timeline.length > 0 || links.length > 0 || !!record.href || !!children || (active && typeof record.progress === "number");
  // Open on arrival when it needs the owner; anything else opens by its body.
  const [open, setOpen] = useState(state === "needs" || state === "failed");
  const name = run?.ref ?? title;
  const steer = () => onCompose({ kind: waiting ? "reply" : "steer", ref: run?.ref, title, handle });
  const reply = () => onCompose({ kind: waiting ? "reply" : "ask", ref: run?.ref, title });
  const router = useRouter();
  const actions = [
    { label: run ? `${run.ref} · ${label}` : label, heading: true },
    steerable ? { label: lingering ? "Steer sub-agent…" : waiting ? "Reply…" : "Steer…", disabled: pending, onSelect: steer } : null,
    canReply ? { label: "Reply…", disabled: pending, onSelect: reply } : null,
    record.href ? { label: "Open conversation", onSelect: () => router.push(record.href!) } : null,
    ...links.map((link) => ({
      label: `Open ${link.label?.trim() || (link.kind === "github" ? "GitHub" : "link")}`,
      onSelect: () => void window.open(link.url, "_blank", "noopener,noreferrer"),
    })),
    run ? { label: `Copy ${run.ref}`, onSelect: () => void navigator.clipboard?.writeText(run.ref).catch(() => undefined) } : null,
    stoppable ? { label: lingering ? "Stop sub-agent…" : "Stop…", danger: true, disabled: pending, onSelect: () => setConfirmStop(true) } : null,
  ].filter((item) => item !== null);
  const rowActions = (
    <>
      {steerable ? (
        <RowAction
          label={`${lingering ? "Steer sub-agent of" : waiting ? "Reply to" : "Steer"} ${name}`}
          icon={<SteerIcon className={ic} />}
          disabled={pending}
          onClick={steer}
        />
      ) : null}
      {canReply ? <RowAction label={`Reply to ${name}`} icon={<SteerIcon className={ic} />} disabled={pending} onClick={reply} /> : null}
      {stoppable ? (
        <RowAction
          label={`${lingering ? "Stop sub-agent of" : "Stop"} ${name}`}
          tone="danger"
          icon={<StopIcon className={ic} />}
          disabled={pending}
          aria-expanded={confirmStop}
          onClick={() => setConfirmStop(!confirmStop)}
        />
      ) : null}
      {!steerable && !canReply && !stoppable && hasMore ? (
        <RowAction label={`Log for ${name}`} icon={<LogIcon className={ic} />} aria-expanded={open} onClick={() => setOpen((value) => !value)} />
      ) : null}
    </>
  );
  return (
    <SummaryCard
      label={title}
      actions={actions}
      // Nothing to offer, or only the one action already on the row: the browser's own menu stays.
      menuEnabled={actions.length > 2}
      trigger={false}
      className="rc-row rc-exec"
      data-state={tracked ? tracked.key : stalled ? "stuck" : record.state}
      data-live={isLive || undefined}
      data-open={(open && hasMore) || undefined}
      data-testid="coordinator-run-card"
      aria-label={record.title}
    >
      <ThingRow
        state={state}
        refId={run?.ref}
        title={<span title={record.title}>{title}</span>}
        tight={(state === "done" || state === "stopped") && !open}
        sub={
          <SubLine
            state={<RowState state={state} label={label} live={isLive} burst={burst} celebrate={record.state === "completed"} />}
            parts={[detail, active && record.step ? tidyOutcome(record.step) : null, lingering ? "a sub-agent is still working" : null]}
          />
        }
        expanded={hasMore ? open : undefined}
        onOpen={hasMore ? () => setOpen((value) => !value) : undefined}
        actions={rowActions}
      >
        {tells ? (
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
          <div className="rc-progress" data-live={isLive || undefined}>
            <ProgressBar value={record.progress * 100} tone="ai" label={`${Math.round(record.progress * 100)}% done`} />
          </div>
        ) : null}
        {timeline.length ? <RunTimeline events={timeline} runTitle={record.title} label={`Latest events for ${run!.ref}`} live={isLive} /> : null}
        {children}
        {record.href || links.length ? (
          <div className="rc-actions">
            {record.href ? (
              <ButtonLink size="sm" variant="ghost" className="rc-act" href={record.href} icon={<ChatIcon className={small} />}>
                Open
              </ButtonLink>
            ) : null}
            {links.map((link) => (
              <ButtonLink key={link.url} size="sm" variant="ghost" className="rc-act" href={link.url} external icon={<ExternalIcon className={small} />}>
                {link.label?.trim() || (link.kind === "github" ? "GitHub" : "Link")}
              </ButtonLink>
            ))}
          </div>
        ) : null}
      </ThingRow>
      {confirmStop ? (
        <div role="group" aria-label={`Stop ${title}?`} className="rc-confirm">
          <p>{viaRun ? `Stop ${run!.ref} and its sub-agents?` : "Stop this sub-agent?"} The request goes to the coordinator as soon as you confirm.</p>
          <Button
            size="sm"
            variant="danger"
            loading={pending}
            onClick={() =>
              void onControl(viaRun ? `Stop ${run!.ref} (${title}) and its sub-agents.` : stopText(handle))
                .then(() => setConfirmStop(false))
                .catch(() => undefined)
            }
          >
            {viaRun ? `Stop ${run!.ref}` : "Stop sub-agent"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </SummaryCard>
  );
}
