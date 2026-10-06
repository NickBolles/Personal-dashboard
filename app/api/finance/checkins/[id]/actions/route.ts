import { z } from "zod";
import { api } from "@/server/http/api";
import { addAction } from "@/server/finance/checkins";
import { assertLinkableEvent } from "@/server/finance/plan";
import { actionInput } from "@/lib/finance/schemas";

export const POST = api<z.infer<typeof actionInput>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    if (body.planEventId) assertLinkableEvent(body.planEventId);
    return { id: addAction(params.id, body, user.id, correlationId) };
  },
  { cap: "finance.edit", body: actionInput },
);
