import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { checkInTask } from "@/server/work/task-runs";
import { listItems } from "@/server/work/store";

/**
 * "Check in": ask a silent task's agent for a status, in the task's chat. The owner's own tap sends it; nothing
 * calls this by itself.
 */
export const POST = api<undefined, { id: string }>(
  ({ user, params, correlationId }) => {
    const item = listItems(user.id).find((i) => i.id === params.id);
    if (!item) throw new HttpError(404, "not_found", "Task not found");
    return checkInTask(user, item, correlationId);
  },
  { capAll: ["work.use", "hermes.chat"] },
);
