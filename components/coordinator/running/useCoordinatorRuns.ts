"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { LookSurface } from "@/lib/cw-runs";
import type { RunsResponse } from "@/lib/coordinator/runs-view";

export const COORDINATOR_RUNS_KEY = ["work", "coordinator", "runs"] as const;
/** `live`: the runs are on screen (Activity, or run cards in Chat), so keep them current; otherwise a slow tick feeds the tray. */
export function useCoordinatorRuns(live = false, enabled = true) {
  return useQuery({
    queryKey: COORDINATOR_RUNS_KEY,
    queryFn: ({ signal }) => api.get<RunsResponse>("/api/coordinator/runs", signal),
    enabled,
    refetchInterval: live ? 10_000 : 30_000,
  });
}

export type ResumeAllResponse = { results: { ref: string; ok: boolean; sent?: "run" | "steer" | "already"; reason?: string }[] };

/** Owner-confirmed Resume all: the server sends one resume prompt per interrupted run's session. */
export function useResumeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (refs: string[]) => api.post<ResumeAllResponse>("/api/coordinator/runs/resume", { refs, confirm: true }),
    onSettled: () => qc.invalidateQueries({ queryKey: COORDINATOR_RUNS_KEY }),
  });
}

/** Call mutate(surface) once after capturing the previous marker for the visible visit. */
export function useMarkLooked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (surface: LookSurface) => api.post<Pick<RunsResponse, "lastLooked">>("/api/coordinator/looked", { surface }),
    onMutate: async (surface) => {
      await qc.cancelQueries({ queryKey: COORDINATOR_RUNS_KEY });
      const previous = qc.getQueryData<RunsResponse>(COORDINATOR_RUNS_KEY)?.lastLooked[surface];
      const optimistic = new Date().toISOString();
      qc.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, (old) =>
        old?.lastLooked ? { ...old, lastLooked: { ...old.lastLooked, [surface]: optimistic } } : old,
      );
      return { previous, optimistic };
    },
    onError: (_error, surface, context) => {
      qc.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, (old) =>
        old?.lastLooked && context && old.lastLooked[surface] === context.optimistic
          ? { ...old, lastLooked: { ...old.lastLooked, [surface]: context.previous ?? null } }
          : old,
      );
    },
    onSuccess: (result, surface, context) => {
      qc.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, (old) =>
        old?.lastLooked && result?.lastLooked && old.lastLooked[surface] === context?.optimistic
          ? { ...old, lastLooked: { ...old.lastLooked, [surface]: result.lastLooked[surface] } }
          : old,
      );
    },
  });
}
