import { api } from "@/server/http/api";
import { stopTask } from "@/server/work/tasks";

/** Stop the work on a task: its open runs read "stopped by you" at once and the turn in its chat is asked to stop. */
export const POST = api<undefined, { id: string }>(({ user, params, correlationId }) => stopTask(user, params.id, correlationId), {
  cap: "work.use",
});
