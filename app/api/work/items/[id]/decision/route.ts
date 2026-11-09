import { api } from "@/server/http/api";
import type { z } from "zod";
import { decisionAnswerSchema } from "@/lib/decisions";
import { answerDecision, type OpOut } from "@/server/work/store";

/**
 * Answer the item's owner decision: logged as activity, appended to the
 * summary, undoable. Never changes status or settles. Posting the answer to the
 * linked conversation is a separate, confirmed client step (the runs route).
 */
export const POST = api<z.infer<typeof decisionAnswerSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const out: OpOut = {};
    const item = answerDecision(user, params.id, body.answer, correlationId, out, body.ref);
    return { item, op: out.op ?? null };
  },
  { cap: "work.use", body: decisionAnswerSchema },
);
