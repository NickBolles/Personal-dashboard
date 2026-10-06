import { z } from "zod";
import { api } from "@/server/http/api";
import { deleteAction, updateAction } from "@/server/finance/checkins";
import { assertLinkableEvent } from "@/server/finance/plan";
import { actionInput, version } from "@/lib/finance/schemas";

const schema = actionInput.partial().extend({ status: z.enum(["planned", "initiated", "settled", "skipped", "cancelled"]).optional(), version });

export const PATCH = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    if (body.planEventId) assertLinkableEvent(body.planEventId);
    updateAction(params.id, body, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);

export const DELETE = api<undefined, { id: string }>(
  ({ params, user, correlationId }) => {
    deleteAction(params.id, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit" },
);
