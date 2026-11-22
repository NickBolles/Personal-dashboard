import { api } from "@/server/http/api";
import { stopRun } from "@/server/assistant";
import { undoOp } from "@/server/work/store";

/**
 * Undo a structural operation: only the item's latest one, once, within the window (server/work/undo-rules.ts).
 * Undoing a bot's start or hand-off also asks the assistant to stop that turn (the run is already marked stopped).
 */
export const POST = api<undefined, { id: string }>(
  async ({ user, params, correlationId }) => {
    const result = undoOp(user, params.id, correlationId);
    if ("stopRunId" in result && typeof result.stopRunId === "string") {
      const { stopRunId, ...rest } = result;
      // Best effort: a turn that already ended (or an assistant that is not answering) is not an undo failure.
      await stopRun(user, stopRunId, correlationId).catch(() => undefined);
      return rest;
    }
    return result;
  },
  { cap: "work.use" },
);
