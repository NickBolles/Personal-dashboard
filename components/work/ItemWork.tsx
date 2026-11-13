"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccess } from "@/components/access";
import { CopyField, useAgentRuns } from "@/components/agents/AgentRuns";
import { ChatIcon, LogIcon, RetryIcon, StopIcon } from "@/components/icons";
import { Button, RefPill, RowAction, StateWord, ThingRow, useNow } from "@/components/ui";
import { AgentChip } from "@/components/work/AgentChip";
import { itemAiKey, ReportViewer, useItemAi } from "@/components/work/ai/AiActions";
import { useWorkMutation } from "@/components/work/common";
import type { UndoOp } from "@/components/work/UndoBar";
import type { JobView } from "@/lib/ai";
import { api } from "@/lib/client/api";
import type { Decision } from "@/lib/cw-decisions";
import { ageLabel } from "@/lib/coordinator/needs";
import { tidyOutcome } from "@/lib/coordinator/run-card";
import type { RunsResponse } from "@/lib/coordinator/runs-view";
import { RunTimeline } from "@/components/coordinator/running/RunCard";
import type { RunEvent } from "@/lib/cw-runs";
import {
  coordHref,
  groupWork,
  itemTimeline,
  itemWorkRows,
  runWorkState,
  type ChatWorkRow,
  type ItemWorkRow,
  type JobWorkRow,
  type ReportWorkRow,
  type RunWorkRow,
} from "@/lib/item-page";
import { relativeTime } from "@/lib/time";
import { WORK_WORD } from "@/lib/work-words";

/**
 * The tracked runs (R-n) and open decisions (D-n) the app already keeps warm for the Chief of staff panel, read
 * here under the same query keys so the item and project pages can name a run or a decision by its reference.
 */
export function useWorkSignals(enabled = true) {
  const agents = useAgentRuns(enabled);
  const runs = useQuery({
    queryKey: ["work", "coordinator", "runs"],
    queryFn: ({ signal }) => api.get<RunsResponse>("/api/coordinator/runs", signal),
    enabled,
    refetchInterval: 30_000,
  });
  const decisions = useQuery({
    queryKey: ["work", "coordinator", "decisions"],
    queryFn: ({ signal }) => api.get<{ decisions: Decision[] }>("/api/coordinator/decisions?state=open", signal),
    enabled,
    refetchInterval: 30_000,
  });
  return { agents: agents.data?.items, runs: runs.data?.runs, events: runs.data?.events, decisions: decisions.data?.decisions };
}

/** Every run, AI job and report on one item as rows, and its timeline (lib/item-page.ts), kept current. */
export function useItemWork(itemId: string, enabled = true) {
  const canAi = useAccess().can("work.ai");
  const { agents, runs, events, decisions } = useWorkSignals(enabled);
  const ai = useItemAi(itemId, enabled);
  const now = useNow();
  const info = agents?.[itemId];
  const jobs = canAi ? ai.data?.jobs : undefined;
  const reports = ai.data?.reports;
  const rows = useMemo(() => itemWorkRows({ info, runs, decisions, jobs, reports, now }), [info, runs, decisions, jobs, reports, now]);
  const timeline = useMemo(() => itemTimeline({ itemId, runs, events, reports }), [itemId, runs, events, reports]);
  // The conversation behind the newest run (else the item's own linked conversation): where the reasoning is.
  const sessionId = info?.agentRuns?.find((run) => run.hermesSessionId)?.hermesSessionId ?? info?.sessionId ?? null;
  return { rows, timeline, sessionId, info, agents, runs, decisions };
}

/** How many timeline entries show before "Show earlier". */
const TIMELINE_SHOWN = 4;

/**
 * Timeline: what the agents on the item have been doing, newest first, one line each with its time, so the owner
 * can see where it is at without opening the chat. The same timeline a run card draws (RunTimeline); the heading
 * links to the conversation for the reasoning.
 */
export function ItemTimeline({ events, live, sessionId }: { events: readonly RunEvent[]; live?: boolean; sessionId?: string | null }) {
  const [all, setAll] = useState(false);
  if (!events.length) return null;
  const earlier = events.length - TIMELINE_SHOWN;
  return (
    <div className="ip-timeline" data-testid="item-timeline">
      <h4 className="ip-sublabel ip-timeline-h">
        Timeline
        {sessionId ? (
          <Link href={`/chat/${encodeURIComponent(sessionId)}`} className="ip-link">
            Open conversation
          </Link>
        ) : null}
      </h4>
      <RunTimeline events={all ? events : events.slice(0, TIMELINE_SHOWN)} runTitle="" label="What the agents on this item did, newest first" live={live} />
      {earlier > 0 ? (
        <Button variant="ghost" size="sm" className="ip-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer" : `Show earlier (${earlier})`}
        </Button>
      ) : null}
    </div>
  );
}

/** The DOM id of a work row, for "jump to it" chips. */
export const workRowId = (key: string) => `work-${key.replace(/[^\w-]/g, "-")}`;

/** The state in the shared words, then what the row has to say, then how long ago. */
function Line({ row, now, stalledId }: { row: ItemWorkRow; now: number; stalledId?: boolean }) {
  // A stalled row's note already says how long it has been silent.
  const when = row.at && row.state !== "stalled" && Number.isFinite(Date.parse(row.at)) ? ageLabel(row.at, now) : "";
  return (
    <>
      <span data-testid={stalledId && row.state === "stalled" ? "agent-stalled" : "agent-live"}>
        <StateWord state={row.state} />
      </span>
      {row.note ? ` · ${row.note}` : ""}
      {when ? <span data-dynamic>{` · ${when}`}</span> : null}
    </>
  );
}

function RunRow({ row, itemId, now, open, onToggle }: { row: RunWorkRow; itemId: string; now: number; open: boolean; onToggle: () => void }) {
  const router = useRouter();
  const { run } = row;
  const said = tidyOutcome(run.summary);
  return (
    <ThingRow
      id={workRowId(row.key)}
      className="ip-row"
      data-testid="agent-run"
      data-stalled={row.state === "stalled" || undefined}
      state={row.state}
      refId={row.refId ?? undefined}
      title={row.title}
      sub={<Line row={row} now={now} stalledId />}
      expanded={open}
      onOpen={onToggle}
      actions={
        <>
          {run.hermesSessionId ? (
            <RowAction
              label="Open conversation"
              icon={<ChatIcon className="h-4 w-4" />}
              onClick={() => router.push(`/chat/${encodeURIComponent(run.hermesSessionId!)}`)}
            />
          ) : null}
          {row.refId ? (
            <RowAction
              label={`Log of ${row.refId}`}
              icon={<LogIcon className="h-4 w-4" />}
              onClick={() => router.push(coordHref(itemId, "running", row.refId!))}
            />
          ) : null}
        </>
      }
    >
      {said ? <p className="ip-said">{said}</p> : null}
      <p className="ip-detail-meta">
        <AgentChip profile={run.profile} />
        {row.decision ? <RefPill id={row.decision.ref} onClick={() => router.push(coordHref(itemId, "needs", row.decision!.ref))} /> : null}
        {run.prUrl ? (
          <a href={run.prUrl} target="_blank" rel="noreferrer noopener" className="ip-link">
            Pull request<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        <span data-dynamic>started {relativeTime(run.startedAt, now)}</span>
      </p>
      {run.children?.length ? (
        <ul className="ip-subagents" aria-label={`Sub-agents of ${run.title}`} data-testid="agent-run-children">
          {run.children.map((child, n) => (
            <li key={n}>
              <span className="ip-subagent-t">{child.title}</span>{" "}
              <StateWord state={runWorkState({ state: child.state, updatedAt: new Date(now).toISOString() }, now)} />
              {child.summary ? <span className="ip-subagent-s">{child.summary}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {run.delegationId || run.hermesSessionId || run.transcriptPath ? (
        <div className="ip-copies">
          {run.delegationId ? <CopyField label="Delegation" value={run.delegationId} /> : null}
          {run.hermesSessionId ? <CopyField label="Hermes session" value={run.hermesSessionId} /> : null}
          {run.transcriptPath ? <CopyField label="Transcript" value={run.transcriptPath} /> : null}
        </div>
      ) : null}
    </ThingRow>
  );
}

/** "1:23" since a job started, ticking while it is on screen. */
function Elapsed({ from }: { from: string }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  return <span data-dynamic>{` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</span>;
}

/**
 * An AI job still going (or just failed). Stop asks once in place, then stops; Retry restarts a failed job; a job
 * held by today's budget opens to its explicit "Run anyway".
 */
function JobRow({ row, itemId }: { row: JobWorkRow; itemId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: itemAiKey(itemId) });
  const cancel = useWorkMutation((id: string) => api.post<JobView>(`/api/ai/jobs/${id}/cancel`, {}), { onSuccess: refresh });
  const retry = useWorkMutation((id: string) => api.post<JobView>(`/api/ai/jobs/${id}/retry`, {}), { onSuccess: refresh });
  const anyway = useWorkMutation((id: string) => api.post<JobView>(`/api/ai/jobs/${id}/run-anyway`, {}), { onSuccess: refresh });
  const [asking, setAsking] = useState(false);
  const { job } = row;
  const stoppable = job.state === "queued" || job.state === "running" || job.state === "waiting_approval";
  return (
    <ThingRow
      id={workRowId(row.key)}
      className="ip-row"
      data-testid="ai-job-chip"
      role="status"
      state={row.state}
      title={row.title}
      sub={
        <>
          <StateWord state={row.state} />
          {` · ${row.note}`}
          {job.state === "running" && job.startedAt ? <Elapsed from={job.startedAt} /> : null}
        </>
      }
      expanded={job.state === "budget_blocked" ? true : undefined}
      actions={
        asking ? (
          <>
            <Button size="sm" variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate(job.id, { onSettled: () => setAsking(false) })}>
              Stop
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            {job.state === "waiting_approval" && job.conversationId ? (
              <RowAction
                label="Open conversation"
                icon={<ChatIcon className="h-4 w-4" />}
                onClick={() => router.push(`/chat/${encodeURIComponent(job.conversationId!)}`)}
              />
            ) : null}
            {stoppable ? <RowAction label={`Stop ${row.title}`} tone="danger" icon={<StopIcon className="h-4 w-4" />} onClick={() => setAsking(true)} /> : null}
            {job.state === "failed" ? (
              <RowAction
                label={`Retry ${row.title}`}
                icon={<RetryIcon className="h-4 w-4" />}
                disabled={retry.isPending}
                onClick={() => retry.mutate(job.id)}
              />
            ) : null}
          </>
        )
      }
    >
      {job.state === "budget_blocked" ? (
        <div className="ip-detail-meta">
          <span>Held: it would go over today&apos;s AI budget.</span>
          <Button size="sm" variant="danger" loading={anyway.isPending} onClick={() => anyway.mutate(job.id)}>
            Run anyway
          </Button>
        </div>
      ) : null}
    </ThingRow>
  );
}

function ReportRow({ row, now, onOpen }: { row: ReportWorkRow; now: number; onOpen: () => void }) {
  return (
    <ThingRow
      id={workRowId(row.key)}
      className="ip-row"
      state="done"
      title={
        <>
          {row.report.readAt ? null : <span className="ai-unread-dot ip-unread" role="img" aria-label="Unread" />}
          {row.title}
        </>
      }
      sub={<Line row={row} now={now} />}
      onOpen={onOpen}
      hitProps={{ "data-testid": "ai-report-row", "aria-haspopup": "dialog" }}
      actions={<RowAction label={`Open report: ${row.title}`} icon={<LogIcon className="h-4 w-4" />} onClick={onOpen} />}
    />
  );
}

/** A linked conversation's own run: the row is the link to that conversation. */
function ChatRow({ row, now }: { row: ChatWorkRow; now: number }) {
  return (
    <ThingRow
      id={workRowId(row.key)}
      className="ip-row"
      data-testid="agent-chat"
      state={row.state}
      title={row.title}
      sub={<Line row={row} now={now} />}
      href={row.sessionId ? `/chat/${encodeURIComponent(row.sessionId)}` : undefined}
      actions={row.sessionId ? <ChatIcon className="ip-chev h-4 w-4" /> : undefined}
    />
  );
}

/**
 * Work: every run, job and report on the item as one list, in the order Needs you, Working, Done. A row opens in
 * place for what a card would show (the full report line, sub-agents, the pull request, ids to copy). Finished
 * work folds into one "Done" row once there is more than one. Not drawn when the item has no work.
 */
export function ItemWorkList({
  itemId,
  areaId,
  rows,
  open,
  onToggle,
  onOp,
  label = "Work",
  timeline = [],
  sessionId,
}: {
  itemId: string;
  areaId: string | null;
  rows: readonly ItemWorkRow[];
  /** The section's heading ("Reports" on a project page, which lists only its own jobs and reports). */
  label?: string;
  /** What the agents on the item did, newest first (drawn under the rows). */
  timeline?: readonly RunEvent[];
  /** The conversation the timeline links to. */
  sessionId?: string | null;
  /** Keys of the rows open in place (held by the page, so a "jump to it" chip can open one). */
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOp?: (op: UndoOp | null) => void;
}) {
  const now = useNow();
  const groups = groupWork(rows);
  const unread = groups.done.some((r) => r.kind === "report" && !r.report.readAt);
  const [doneOpen, setDoneOpen] = useState<boolean | null>(null);
  const showDone = doneOpen ?? unread;
  // A report link (?report=<id>, from a notification) opens that report.
  const [report, setReport] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("report")));
  if (!rows.length && !report) return null;
  const draw = (row: ItemWorkRow) =>
    row.kind === "run" ? (
      <RunRow key={row.key} row={row} itemId={itemId} now={now} open={open.has(row.key)} onToggle={() => onToggle(row.key)} />
    ) : row.kind === "job" ? (
      <JobRow key={row.key} row={row} itemId={itemId} />
    ) : row.kind === "report" ? (
      <ReportRow key={row.key} row={row} now={now} onOpen={() => setReport(row.report.id)} />
    ) : (
      <ChatRow key={row.key} row={row} now={now} />
    );
  return (
    <section className="ip-sec" aria-label={label} data-testid="item-agent-panel" id="work-reports">
      {rows.length ? (
        <>
          <h3 className="ip-label">
            {label} <span className="ip-count">· {rows.length}</span>
          </h3>
          <div className="ip-rows" data-testid="agent-runs-list">
            {groups.needs.map(draw)}
            {groups.working.map(draw)}
            {groups.done.length > 1 ? (
              <ThingRow
                className="ip-row"
                state="done"
                tight
                title={WORK_WORD.done}
                sub={`${groups.done.length} finished`}
                onOpen={() => setDoneOpen(!showDone)}
                hitProps={{ "aria-expanded": showDone }}
                data-testid="work-done"
              />
            ) : null}
            {groups.done.length === 1 || showDone ? groups.done.map(draw) : null}
          </div>
          <ItemTimeline events={timeline} live={groups.working.length > 0} sessionId={sessionId} />
        </>
      ) : null}
      {report ? <ReportViewer reportId={report} itemId={itemId} areaId={areaId} onClose={() => setReport(null)} onOp={onOp} /> : null}
    </section>
  );
}
