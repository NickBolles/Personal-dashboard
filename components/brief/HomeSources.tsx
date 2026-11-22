"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banner, ButtonLink, useOnline } from "@/components/ui";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import type { HomePayload, SourceStatus } from "@/lib/contracts";
import { BRIEF_KEY } from "./useBrief";

const PROBLEM: SourceStatus["state"][] = ["stale", "error", "unauthorized"];

/**
 * With the brief as Home, this keeps Home's promises about its sources: the
 * same live read refreshes them each minute (the brief reads what that leaves
 * cached), and a source that is stale, failing or signed out is said out loud,
 * never shown as "nothing there".
 */
export function HomeSources() {
  const online = useOnline();
  const qc = useQueryClient();
  const live = useQuery({
    queryKey: ["home", "live"],
    queryFn: () => api.get<HomePayload>("/api/home"),
    refetchInterval: 60_000,
    enabled: online,
  });
  // Fresh source data changes what the brief shows (picks done, the deck): read it again.
  useEffect(() => {
    if (live.dataUpdatedAt) void qc.invalidateQueries({ queryKey: BRIEF_KEY, exact: true });
  }, [live.dataUpdatedAt, qc]);

  const problems = (live.data?.sources ?? []).filter((s) => PROBLEM.includes(s.state));
  if (online && !problems.length) return null;
  const needsAuth = problems.some((s) => s.state === "unauthorized");
  return (
    <Banner
      tone="wn"
      action={
        needsAuth ? (
          <ButtonLink href="/settings/connections" size="sm" variant="ghost">
            Fix connection
          </ButtonLink>
        ) : undefined
      }
    >
      {!online ? (
        <span className="block">Offline: showing what Jarvis had {live.data ? relativeTime(live.data.generatedAt) : "at your last visit"}.</span>
      ) : null}
      {problems.map((s) => (
        <span key={s.source} className="block">
          <strong className="font-semibold">{s.label}:</strong>{" "}
          {s.state === "unauthorized"
            ? "needs you to sign in again."
            : s.state === "error"
              ? `couldn’t refresh${s.fetchedAt ? ` (showing data from ${relativeTime(s.fetchedAt)})` : ", nothing cached yet"}.`
              : `data from ${s.fetchedAt ? relativeTime(s.fetchedAt) : "earlier"}.`}
        </span>
      ))}
    </Banner>
  );
}
