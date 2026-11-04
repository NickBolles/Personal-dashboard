import { api } from "@/server/http/api";
import { coordinatorFor, globalCoordinatorArea, lastRunAt } from "@/server/work/coordinator";

/** Read-only global entry point; never starts or sends a conversation. */
export const GET = api(
  ({ user }) => {
    const area = globalCoordinatorArea(user);
    if (!area) return { area: null };
    const info = coordinatorFor(user, area.id);
    return { ...info, lastRunAt: lastRunAt(user, info.sessionId), scope: "global" as const };
  },
  { cap: "work.use" },
);
