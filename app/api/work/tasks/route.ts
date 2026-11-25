import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { TASK_VIEWS, type TaskView } from "@/lib/task-list";
import { taskList } from "@/server/work/tasks";

export const dynamic = "force-dynamic";

/**
 * The task list: In flight (`view=flight`), every open task (`all`) or the review queue (`review`), for everything
 * (`scope=all`), one channel or one project (`scope=<id>`). One row per task; from Jarvis's own records only.
 */
export const GET = api(
  ({ user, req }) => {
    const q = req.nextUrl.searchParams;
    const view = q.get("view") ?? "flight";
    if (!(TASK_VIEWS as readonly string[]).includes(view)) throw new HttpError(400, "view", "Unknown view");
    const scope = q.get("scope") ?? "all";
    if (scope.length > 64) throw new HttpError(400, "scope", "Unknown scope");
    return taskList(user, { scope, view: view as TaskView });
  },
  { cap: "work.use" },
);
