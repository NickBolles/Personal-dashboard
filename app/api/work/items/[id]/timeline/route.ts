import { api } from "@/server/http/api";
import { taskTimeline } from "@/server/work/tasks";

export const dynamic = "force-dynamic";

/** A task's timeline, newest first: its runs' reports, the questions it raised and their answers, how it began. */
export const GET = api<undefined, { id: string }>(({ user, params }) => taskTimeline(user, params.id), { cap: "work.use" });
