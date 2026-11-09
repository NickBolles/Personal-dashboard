import type { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { answerSchema } from "@/lib/cw-decisions";
import { answerDecisionRef } from "@/server/work/decision-store";
import type { OpOut } from "@/server/work/store";
import { refParam } from "@/app/api/coordinator/ref";

/**
 * Owner answers one decision (D-n) from the queue, a push action or chat. Owner session only:
 * agent tokens never reach this route (bearer agent tokens work on /api/mcp only) and the
 * store refuses inside an agent call. Logged, appended to the item summary, undoable.
 */
export const POST = api<z.infer<typeof answerSchema>, { ref: string }>(
  ({ user, params, body, correlationId }) => {
    const ref = refParam(params.ref);
    if (!ref) throw new HttpError(404, "not_found", "That decision isn't here");
    const out: OpOut = {};
    const res = answerDecisionRef(user.id, ref, body.answer, body.via ?? "queue", correlationId, out);
    return { ...res, op: out.op ?? null };
  },
  { cap: "work.use", body: answerSchema },
);
