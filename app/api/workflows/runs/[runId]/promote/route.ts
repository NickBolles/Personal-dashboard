import { z } from "zod";
import { api } from "@/server/http/api";
import { promoteActions, promoteBody } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

/** Confirmed write: create work items from the checked actions (titles must match the confirm sheet). */
export const POST = api<z.infer<typeof promoteBody>, { runId: string }>(
  ({ user, params, body, correlationId }) => promoteActions(user, { userId: user.id, correlationId }, params.runId, body),
  { cap: "work.use", body: promoteBody },
);
