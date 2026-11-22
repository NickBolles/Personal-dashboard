"use client";

import { useQuery } from "@tanstack/react-query";
import { Dot } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { ResumeResponse, ResumeRow } from "@/lib/resume";

/** The rows Today's "Pick up where you left off" strip reads. In flight itself is the task list (components/tasks). */
export function useResume(enabled = true) {
  return useQuery({
    queryKey: ["work", "resume"],
    queryFn: () => api.get<ResumeResponse>("/api/work/resume"),
    enabled,
    refetchInterval: (query) => (query.state.data?.updating ? 5_000 : 30_000),
  });
}

export function ResumeDot({ row }: { row: ResumeRow }) {
  if (row.kind === "conversation") return <Dot tone={row.unread ? "ac" : "neutral"} label={row.unread ? "Unread" : "Conversation"} />;
  return (
    <Dot
      tone={row.live === "waiting" || row.stalled ? "wn" : row.live === "failed" ? "bad" : row.live === "running" ? "ai" : "neutral"}
      live={row.live === "running" && !row.stalled}
      label={
        row.stalled
          ? "Stalled"
          : row.live === "waiting"
            ? "Waiting for you"
            : row.live === "running"
              ? "Running"
              : row.live === "failed"
                ? "Failed"
                : "Finished"
      }
    />
  );
}
