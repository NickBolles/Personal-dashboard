"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { AgentMark } from "@/components/brand/AgentMark";
import { Dot, Pill, ProgressBar, type KTone } from "@/components/ui/kit";
import {
  CHECKS_LABEL,
  DEPLOY_LABEL,
  RUN_LIVE_LABEL,
  liveOfAgentRun,
  progressPct,
  whoLabel,
  type AgentRunsResponse,
  type ItemAgentInfo,
  type PrState,
  type RunLive,
} from "@/lib/agent-runs";
import { relativeTime } from "@/lib/time";
import { AgentChip } from "@/components/work/AgentChip";
import "./agents.css";

export const AGENT_RUNS_KEY = ["work", "agent-runs"] as const;

/** Agent runs on items (read-only aggregation); polls while the app is visible. */
export function useAgentRuns(enabled = true) {
  return useQuery({
    queryKey: AGENT_RUNS_KEY,
    queryFn: () => api.get<AgentRunsResponse>("/api/work/agent-runs"),
    enabled,
    staleTime: 15_000,
    refetchInterval: 20_000,
  });
}

const LIVE_TONE: Record<RunLive, KTone> = { running: "ai", waiting: "wn", failed: "bad", finished: "ok", idle: "neutral" };

/** Live state dot + label ("Running", "Waiting for approval", …). */
export function LiveState({ live, at, compact }: { live: RunLive; at?: string | null; compact?: boolean }) {
  return (
    <span className="ar-live" data-live={live} data-testid="agent-live">
      <Dot tone={LIVE_TONE[live]} live={live === "running"} />
      <span>{RUN_LIVE_LABEL[live]}</span>
      {at && !compact ? (
        <span className="text-muted" data-dynamic>
          · {relativeTime(at)}
        </span>
      ) : null}
    </span>
  );
}

/** One-line "who + live state" for map rows. */
export function AgentLine({ info }: { info: ItemAgentInfo }) {
  return (
    <span className="ar-line" data-testid="agent-line">
      {info.who ? <AgentMark name={info.who.kind === "person" ? null : info.who.name} busy={info.live === "running"} /> : null}
      <span className="min-w-0 truncate">{whoLabel(info.who)}</span>
      {info.live !== "idle" ? <LiveState live={info.live} compact /> : null}
    </span>
  );
}

const PR_TONE = (p: PrState): KTone => (p.state === "merged" ? "ai" : p.state === "closed" ? "neutral" : "ac");
const CHECK_TONE: Record<string, KTone> = { success: "ok", failure: "bad", pending: "wn" };

function PrRow({ pr }: { pr: PrState }) {
  const name = pr.title || pr.ref;
  return (
    <li className="ar-pr" data-testid="agent-pr">
      {pr.url ? (
        <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium hover:underline">
          {name}
        </a>
      ) : (
        <span className="min-w-0 truncate font-medium">{name}</span>
      )}
      <span className="flex flex-wrap items-center gap-1">
        <Pill tone={PR_TONE(pr)}>{pr.state ? pr.state[0]!.toUpperCase() + pr.state.slice(1) : "Not read yet"}</Pill>
        {pr.checks ? <Pill tone={CHECK_TONE[pr.checks] ?? "neutral"}>{CHECKS_LABEL[pr.checks] ?? pr.checks}</Pill> : null}
        {pr.deploy ? <Pill tone={pr.deploy === "live" ? "ok" : "wn"}>{DEPLOY_LABEL[pr.deploy]}</Pill> : null}
      </span>
    </li>
  );
}

/**
 * Item agent panel: who is on it, the live state of its runs (from linked Hermes
 * conversations and AI jobs), its PRs with CI/merge/deploy state and the last
 * report. Read-only.
 */
export function ItemAgentPanel({ itemId }: { itemId: string }) {
  const q = useAgentRuns();
  const info = q.data?.items[itemId];
  if (!info) return null;
  const pct = progressPct(info.progress);
  return (
    <section className="ar-panel" aria-labelledby={`ar-h-${itemId}`} data-testid="item-agent-panel">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={`ar-h-${itemId}`} className="wk-label">
          Agent
        </h3>
        {info.who ? <AgentMark name={info.who.kind === "person" ? null : info.who.name} busy={info.live === "running"} /> : null}
        <span className="min-w-0 text-[13px] font-medium [overflow-wrap:anywhere]" data-testid="agent-who">
          {whoLabel(info.who)}
        </span>
        <LiveState live={info.live} at={info.liveAt} />
        {info.sessionId ? (
          <Link href={`/chat/${encodeURIComponent(info.sessionId)}`} className="ml-auto text-xs text-accent hover:underline">
            Open conversation
          </Link>
        ) : null}
      </div>
      {pct !== null ? (
        <div className="mt-2">
          <ProgressBar value={pct} tone="orb" label={`${info.progress!.done} of ${info.progress!.total} done`} />
        </div>
      ) : null}
      {info.prs.length ? (
        <ul className="mt-2 space-y-1.5" aria-label="Pull requests">
          {info.prs.map((p, n) => (
            <PrRow key={n} pr={p} />
          ))}
        </ul>
      ) : null}
      {info.agentRuns?.length ? (
        <ul className="mt-2 space-y-1.5" aria-label="Agent runs" data-testid="agent-runs-list">
          {info.agentRuns.map((r) => (
            <li key={r.id} className="min-w-0 text-[13px]">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{r.title}</span>
                <AgentChip profile={r.profile} />
                <LiveState live={liveOfAgentRun(r.state)} at={r.updatedAt} compact />
                {r.prUrl ? (
                  <a href={r.prUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                    PR
                  </a>
                ) : null}
              </div>
              {r.summary ? <p className="mt-0.5 text-[13px] text-muted [overflow-wrap:anywhere]">{r.summary}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {info.report ? (
        <div className="ar-report mt-2" data-testid="agent-report">
          <p className="text-[13px] font-medium [overflow-wrap:anywhere]">{info.report.title}</p>
          {info.report.summary ? <p className="mt-0.5 text-[13px] [overflow-wrap:anywhere]">{info.report.summary}</p> : null}
          <p className="mt-0.5 text-xs text-muted" data-dynamic>
            Last report · {relativeTime(info.report.at)}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Compact "Agents" strip: active agents with a live dot and progress. Used on
 * /map area cards (inside the card button: no interactive children) and in the
 * Today right rail (links to each item).
 */
export function AgentsStrip({ entries, linked, max = 3 }: { entries: ItemAgentInfo[]; linked?: boolean; max?: number }) {
  if (!entries.length) return null;
  const shown = entries.slice(0, max);
  return (
    <span className="ar-strip" data-testid="agents-strip">
      {shown.map((e) => {
        const pct = progressPct(e.progress);
        const body = (
          <>
            <AgentMark name={e.who?.kind === "person" ? null : (e.who?.name ?? null)} busy={e.live === "running"} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{e.who ? whoLabel(e.who) : "Agent"}</span>
                <LiveState live={e.live} compact />
              </span>
              <span className="block truncate text-xs text-muted">{e.title}</span>
              {pct !== null ? <ProgressBar value={pct} tone="orb" label={`${e.title}: ${e.progress!.done} of ${e.progress!.total} done`} /> : null}
            </span>
          </>
        );
        return linked ? (
          <Link key={e.itemId} href={`/areas?item=${encodeURIComponent(e.itemId)}`} className="ar-agent ar-agent-link" data-testid="agents-strip-row">
            {body}
          </Link>
        ) : (
          <span key={e.itemId} className="ar-agent" data-testid="agents-strip-row">
            {body}
          </span>
        );
      })}
      {entries.length > max ? <span className="text-xs text-muted">+{entries.length - max} more</span> : null}
    </span>
  );
}

/** Today right rail (≥1100 px): active agents across every area. */
export function AgentsRail() {
  const q = useAgentRuns();
  const active = q.data?.active ?? [];
  return (
    <section aria-labelledby="agents-rail-h" className="hidden min-[1100px]:block" data-testid="agents-rail">
      <h2 id="agents-rail-h" className="wk-label mb-1.5">
        Agents <span className="text-muted">· {active.length} active</span>
      </h2>
      {active.length ? <AgentsStrip entries={active} linked max={5} /> : <p className="text-sm text-muted">No agents running right now.</p>}
    </section>
  );
}
