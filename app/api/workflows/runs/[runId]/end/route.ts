import { api } from "@/server/http/api";
import { endRun } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

/** End session (summary/export: W4). Never settles anything. */
export const POST = api<undefined, { runId: string }>(({ user, params, correlationId }) => endRun({ userId: user.id, correlationId }, params.runId), {
  cap: "work.use",
});
