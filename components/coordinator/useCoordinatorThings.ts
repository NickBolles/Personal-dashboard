"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { ActivityResponse } from "@/lib/activity";
import { isStalled, liveOfAgentRun, type AgentRunsResponse } from "@/lib/agent-runs";
import { useDecisions } from "@/components/map/Decisions";
import { useAway } from "@/lib/client/away";
import { isCoordinatorChange, priorityLine, stablePriority, type CoordinatorRun, type CoordinatorThings, type PriorityLine } from "@/lib/coordinator/things";

const SEEN_KEY = "jarvis.gc.seen";
const MERGED_SEEN_KEY = "jarvis.gc.mergedSeen";

export function useCoordinatorThings() {
  const decisions = useDecisions();
  const away = useAway();
  const runs = useQuery({ queryKey: ["work", "agent-runs"], queryFn: () => api.get<AgentRunsResponse>("/api/work/agent-runs"), refetchInterval: 30_000 });
  const activity = useQuery({
    queryKey: ["activity", "chiefofstaff"],
    queryFn: () => api.get<ActivityResponse>("/api/work/activity?actor=agent&q=chiefofstaff&limit=200"),
    refetchInterval: 30_000,
  });
  const [seen, setSeen] = useState(0);
  const [seenMerges, setSeenMerges] = useState<string[]>([]);
  const [now, setNow] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clock/storage hydrate only in browser
    setNow(Date.now());
    try {
      setSeen(Number(localStorage.getItem(SEEN_KEY)) || 0);
      const merged: unknown = JSON.parse(localStorage.getItem(MERGED_SEEN_KEY) ?? "[]");
      if (Array.isArray(merged)) setSeenMerges(merged.filter((v): v is string => typeof v === "string"));
    } catch {
      /* storage optional */
    }
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const active: CoordinatorRun[] = [];
  const failing: CoordinatorRun[] = [];
  let doneUnseen = 0;
  const mergedIds: string[] = [];
  for (const item of Object.values(runs.data?.items ?? {})) {
    const external = item.agentRuns ?? [];
    for (const run of external) {
      const state = isStalled(run, now) ? "stalled" : run.state;
      if (state !== "done") {
        const row: CoordinatorRun = { id: run.id, itemId: item.itemId, title: run.title, state, at: run.updatedAt };
        if (state === "failed" || state === "stalled") failing.push(row);
        active.push(row);
      }
      if (state === "done" && Date.parse(run.updatedAt) > seen) doneUnseen++;
    }
    // An item may have both a registered delegation and a Hermes/job run.
    if (!external.some((r) => liveOfAgentRun(r.state) === item.live)) {
      const state = item.live;
      if (state === "running" || state === "waiting" || state === "failed") {
        const row: CoordinatorRun = { id: item.itemId, itemId: item.itemId, title: item.title, state, at: item.liveAt };
        active.push(row);
        if (state === "failed") failing.push(row);
      }
      if (state === "finished" && Date.parse(item.liveAt ?? "") > seen) doneUnseen++;
    }
    if (item.prs.some((p) => p.checks === "failure") && !failing.some((r) => r.itemId === item.itemId)) {
      const row: CoordinatorRun = { id: `ci:${item.itemId}`, itemId: item.itemId, title: `${item.title} · CI failing`, state: "failed", at: item.liveAt };
      failing.push(row);
      active.push(row);
    }
    // PRs carry no merge timestamp in this endpoint: remember their stable identity,
    // rather than incorrectly borrowing a run's time or missing PR-only items.
    for (const pr of item.prs) if (pr.state === "merged") mergedIds.push(`${item.itemId}:${pr.ref}`);
  }
  doneUnseen += mergedIds.filter((id) => !seenMerges.includes(id)).length;
  const things: CoordinatorThings = {
    needsYou: decisions.data?.count ?? 0,
    decisions: decisions.data?.entries ?? [],
    running: active,
    failing,
    doneUnseen,
    changes: (activity.data?.items ?? []).filter((a) => isCoordinatorChange(a, now)),
  };
  const base = priorityLine({ needsYou: things.needsYou, running: active.filter((r) => r.state === "running").length, failing: failing.length, doneUnseen });
  const digest = away.data;
  const showAway = !!digest?.line && base.state !== "needs" && base.state !== "failing";
  const next: PriorityLine = showAway
    ? {
        state: digest.counts.needsYou ? "needs" : digest.counts.failed ? "failing" : "done",
        tone: digest.counts.needsYou ? "warn" : digest.counts.failed ? "bad" : "ai",
        dot: digest.counts.failed ? "red" : digest.counts.needsYou ? "yellow" : null,
        text: digest.line!,
        count: digest.counts.ran,
      }
    : base;
  const line = useStableLine(next);
  const markSeen = () => {
    const at = Date.now();
    setSeen(at);
    setSeenMerges(mergedIds);
    try {
      localStorage.setItem(SEEN_KEY, String(at));
      localStorage.setItem(MERGED_SEEN_KEY, JSON.stringify(mergedIds));
    } catch {
      /* storage optional */
    }
  };
  return { things, line, awayLine: showAway && line.text === digest?.line, markSeen, error: decisions.error ?? runs.error ?? activity.error };
}

export function useStableLine(next: PriorityLine): PriorityLine {
  const [shown, setShown] = useState(next);
  const displayed = useRef(next);
  const lowerSince = useRef<number | null>(null);
  const signature = JSON.stringify(next);
  useEffect(() => {
    const candidate: PriorityLine = JSON.parse(signature);
    const now = Date.now();
    const immediate = stablePriority(displayed.current, candidate, now, now) === candidate;
    if (immediate) {
      lowerSince.current = null;
      displayed.current = candidate;
      setShown(candidate);
      return;
    }
    const since = lowerSince.current ?? now;
    lowerSince.current = since;
    const timer = setTimeout(
      () => {
        displayed.current = candidate;
        lowerSince.current = null;
        setShown(candidate);
      },
      Math.max(0, 4000 - (now - since)),
    );
    return () => clearTimeout(timer);
  }, [signature]);
  // Upward transitions render immediately, before the effect flushes.
  return stablePriority(shown, next, 0, 0);
}
