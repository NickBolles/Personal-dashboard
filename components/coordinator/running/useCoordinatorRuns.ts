"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { LookSurface } from "@/lib/cw-runs";
import type { RunsResponse } from "@/lib/coordinator/runs-view";

export const COORDINATOR_RUNS_KEY = ["work", "coordinator", "runs"] as const;
export function useCoordinatorRuns() {
  return useQuery({
    queryKey: COORDINATOR_RUNS_KEY,
    queryFn: ({ signal }) => api.get<RunsResponse>("/api/coordinator/runs", signal),
    refetchInterval: 30_000,
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
      qc.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, (old) => (old ? { ...old, lastLooked: { ...old.lastLooked, [surface]: optimistic } } : old));
      return { previous, optimistic };
    },
    onError: (_error, surface, context) => {
      qc.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, (old) =>
        old && context && old.lastLooked[surface] === context.optimistic
          ? { ...old, lastLooked: { ...old.lastLooked, [surface]: context.previous ?? null } }
          : old,
      );
    },
    onSuccess: (result, surface, context) => {
      qc.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, (old) =>
        old && old.lastLooked[surface] === context?.optimistic ? { ...old, lastLooked: { ...old.lastLooked, [surface]: result.lastLooked[surface] } } : old,
      );
    },
  });
}
