import { api } from "@/server/http/api";
import { taskRowFor } from "@/server/work/tasks";

export const dynamic = "force-dynamic";

/** One task's state and what can be done with it (Stop while it works, Resume or Retry once it stopped). */
export const GET = api<undefined, { id: string }>(({ user, params }) => ({ task: taskRowFor(user, params.id) }), { cap: "work.use" });
