"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { AgentMark } from "@/components/brand/AgentMark";
import { ChipButton, Dot, Pill, ProgressBar, type KTone } from "@/components/ui";
import { STALL_AFTER_MIN, liveLabel, stalledRuns, progressPct, whoLabel, type AgentRunsResponse, type ItemAgentInfo, type RunLive } from "@/lib/agent-runs";
import { relativeTime } from "@/lib/time";
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

/** Re-render once a minute so a run crossing the stall threshold shows "Stalled" without new data. */
function useMinuteTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const LIVE_TONE: Record<RunLive, KTone> = { running: "ai", waiting: "wn", failed: "bad", finished: "ok", idle: "neutral" };

/** Live state dot + label ("Running", "Waiting", "Waiting for approval" only on a real pending approval, …). */
export function LiveState({ live, at, compact, approval }: { live: RunLive; at?: string | null; compact?: boolean; approval?: boolean }) {
  return (
    <span className="ar-live" data-live={live} data-testid="agent-live">
      <Dot tone={LIVE_TONE[live]} live={live === "running"} />
      <span>{liveLabel(live, approval)}</span>
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
  const now = useMinuteTick();
  return (
    <span className="ar-line" data-testid="agent-line">
      {info.who ? <AgentMark name={info.who.kind === "person" ? null : info.who.name} busy={info.live === "running"} /> : null}
      <span className="min-w-0 truncate">{whoLabel(info.who)}</span>
      {info.live !== "idle" ? <LiveState live={info.live} approval={info.approval} compact /> : null}
      {stalledRuns(info, now).length ? <StalledBadge /> : null}
    </span>
  );
}

/** "Stalled": a run still running with no update for STALL_AFTER_MIN. A nudge only; nothing is changed. */
export function StalledBadge() {
  return (
    <span data-testid="agent-stalled" title={`No update for over ${STALL_AFTER_MIN} min`}>
      <Pill tone="wn">Stalled</Pill>
    </span>
  );
}

/** Text shown for copying (transcript path, session/delegation ids): selectable, with a Copy button. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ar-copy">
      <span className="text-xs text-muted">{label}</span>
      <code className="ar-code" data-testid="agent-run-copy">
        {value}
      </code>
      <ChipButton
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </ChipButton>
    </span>
  );
}

/**
 * Compact "Agents" strip: active agents with a live dot and progress. Used on
 * /map area cards (inside the card button: no interactive children) and in the
 * Today right rail (links to each item).
 */
export function AgentsStrip({ entries, linked, max = 3 }: { entries: ItemAgentInfo[]; linked?: boolean; max?: number }) {
  const now = useMinuteTick();
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
                <span className="truncate text-sm font-medium">{e.who ? whoLabel(e.who) : "Agent"}</span>
                <LiveState live={e.live} approval={e.approval} compact />
                {stalledRuns(e, now).length ? <StalledBadge /> : null}
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
