import { api } from "@/server/http/api";
import { assertAwayOwner } from "@/server/agents/schedules";
import { awayDigest } from "@/server/agents/away";
import { defaultDeps, reconcileScheduledRuns } from "@/server/agents/scheduler";
export const dynamic = "force-dynamic";
export const GET = api(
  async ({ user }) => {
    assertAwayOwner(user);
    const now = new Date();
    await reconcileScheduledRuns(user, now, defaultDeps, true);
    return awayDigest(user, now);
  },
  { cap: "admin" },
);
