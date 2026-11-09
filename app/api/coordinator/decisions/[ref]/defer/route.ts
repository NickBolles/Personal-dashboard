import type { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { deferSchema } from "@/lib/cw-decisions";
import { deferDecision } from "@/server/work/decision-store";
import type { OpOut } from "@/server/work/store";
import { refParam } from "@/app/api/coordinator/ref";

/** Owner defers a decision until a time (≤ 30 days); it comes back to Needs you on its own. */
export const POST = api<z.infer<typeof deferSchema>, { ref: string }>(
  ({ user, params, body, correlationId }) => {
    const ref = refParam(params.ref);
    if (!ref) throw new HttpError(404, "not_found", "That decision isn't here");
    const out: OpOut = {};
    const decision = deferDecision(user.id, ref, body.until, correlationId, new Date(), out);
    return { decision, op: out.op ?? null };
  },
  { cap: "work.use", body: deferSchema },
);
