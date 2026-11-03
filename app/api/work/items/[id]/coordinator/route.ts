import { api } from "@/server/http/api";
import { coordinatorFor, lastRunAt } from "@/server/work/coordinator";

/**
 * The area's coordinator chat: who answers, the coordinator conversation and a
 * prepared "Catch me up" prompt. Read-only; the prompt is only sent when the
 * owner taps Send (the runs route). Finance areas get no prompt.
 */
export const GET = api<undefined, { id: string }>(
  ({ user, params }) => {
    const info = coordinatorFor(user, params.id);
    return { ...info, lastRunAt: lastRunAt(user, info.sessionId) };
  },
  { cap: "work.use" },
);
