import "server-only";
import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { listItems } from "@/server/work/store";
import { listAgentTokens } from "@/server/agent-access/tokens";
import { getPreferences } from "@/server/settings";
import { spendToday } from "@/server/ai/budget";
import { getAiSettings } from "@/server/ai/settings";
import { localDayStart } from "@/server/ai/rules";
import { deriveCoordinators, type CoordinatorsResponse } from "@/lib/coordinator-settings";
import { getAgentSettings } from "./routing";

export function coordinatorSettings(userId: string, now = new Date()): CoordinatorsResponse {
  const timezone = getPreferences().timezone;
  const today = localDayStart(now, timezone).toISOString();
  // Anchor the seventh local day via local noon, not an assumed 24h midnight across DST.
  const priorDay = new Date(Date.parse(today) + 12 * 3600_000 - 6 * 86400_000);
  const week = localDayStart(priorDay, timezone).toISOString();
  const J = schema.aiJobs;
  const jobs = getDb()
    .select({
      hermesProfile: J.hermesProfile,
      finishedAt: J.finishedAt,
      state: J.state,
      costUsd: J.costUsd,
      estimateUsd: J.estimateUsd,
      costSource: J.costSource,
    })
    .from(J)
    .where(and(eq(J.userId, userId), gte(J.finishedAt, week)))
    .all();
  const t = spendToday(now);
  return {
    coordinators: deriveCoordinators(getAgentSettings().routes, listItems(userId), listAgentTokens(userId), jobs, { today, week, now: now.toISOString() }),
    budget: { spentUsd: t.spentUsd, reservedUsd: t.reservedUsd, budgetUsd: getAiSettings().dailyBudgetUsd },
  };
}
