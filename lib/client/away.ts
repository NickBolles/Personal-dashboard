"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccess } from "@/components/access";
import { api, ApiError } from "@/lib/client/api";
import type { AwayDigest, EffectiveAutonomy, ScheduledJob } from "@/lib/away";

export type SchedulesResponse = {
  jobs: ScheduledJob[];
  tz: string;
  caps: { maxJobs: number; maxRunsPerDay: number; runsToday: number };
  areas: { id: string; title: string; autonomy: EffectiveAutonomy }[];
};

export const EMPTY_AWAY: AwayDigest = {
  runs: [],
  since: null,
  line: null,
  counts: { ran: 0, failed: 0, changes: 0, needsYou: 0, running: 0, waiting: 0 },
};

export function useAway() {
  const { isAdmin } = useAccess();
  const query = useQuery({ queryKey: ["away"], queryFn: () => api.get<AwayDigest>("/api/agents/away"), refetchInterval: 60_000, enabled: isAdmin });
  // Disabled queries still expose cached data. Don't retain an owner's ledger after a role change.
  return { ...query, data: isAdmin ? query.data : undefined };
}

export function scheduleError(error: unknown) {
  const messages: Record<string, string> = {
    ai_off: "AI is off for this area",
    daily_cap: "Daily limit reached",
    already_running: "This job is already running",
    not_ready: "Pick an area first and set its coordinator agent",
    too_many_jobs: "Job limit reached. Delete a job before adding another.",
  };
  return error instanceof ApiError && error.code && messages[error.code]
    ? messages[error.code]
    : error instanceof Error
      ? error.message
      : "Couldn't save. Try again.";
}
