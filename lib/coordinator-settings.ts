import { AGENT_SCOPES, type AgentScope, type AgentTokenView } from "./agent-access";
import type { AgentRoute } from "./agents";
import type { WorkItem } from "./work";

export type CoordinatorUsageRow = {
  hermesProfile: string | null;
  finishedAt: string | null;
  state: string;
  costUsd: number | null;
  estimateUsd: number;
  costSource?: string | null;
};
export type CoordinatorSummary = {
  profile: string;
  areas: { id: string; title: string; agentMode: string }[];
  scopes: AgentScope[];
  spend: { todayUsd: number; sevenDayUsd: number; estimatedJobs: number; jobs: number };
};
export type CoordinatorsResponse = { coordinators: CoordinatorSummary[]; budget: { spentUsd: number; reservedUsd: number; budgetUsd: number } };

/** Uses only attributed, finished AI jobs, never guesses attribution from the current area's route. */
export function deriveCoordinators(
  routes: Pick<AgentRoute, "profile">[],
  areas: Pick<WorkItem, "id" | "title" | "kind" | "parentId" | "archived" | "settings">[],
  tokens: Pick<AgentTokenView, "profile" | "scopes" | "revokedAt">[],
  jobs: CoordinatorUsageRow[],
  boundaries: { today: string; week: string; now: string },
): CoordinatorSummary[] {
  return routes.map(({ profile }) => {
    const active = tokens.filter((t) => t.profile === profile && !t.revokedAt);
    const attributed = jobs.filter(
      (j) =>
        j.hermesProfile === profile &&
        j.finishedAt &&
        j.finishedAt >= boundaries.week &&
        j.finishedAt <= boundaries.now &&
        ["succeeded", "failed", "cancelled"].includes(j.state),
    );
    return {
      profile,
      areas: areas
        .filter((a) => !a.archived && (a.kind === "area" || a.parentId === null) && a.settings?.agentMode?.trim().toLowerCase() === profile)
        .map((a) => ({ id: a.id, title: a.title, agentMode: a.settings!.agentMode! })),
      scopes: AGENT_SCOPES.filter((scope) => active.some((t) => t.scopes.includes(scope))),
      spend: {
        todayUsd: attributed.filter((j) => j.finishedAt! >= boundaries.today).reduce((n, j) => n + (j.costUsd ?? j.estimateUsd), 0),
        sevenDayUsd: attributed.reduce((n, j) => n + (j.costUsd ?? j.estimateUsd), 0),
        estimatedJobs: attributed.filter((j) => j.costUsd === null || (j.costSource && j.costSource !== "hermes_actual")).length,
        jobs: attributed.length,
      },
    };
  });
}
