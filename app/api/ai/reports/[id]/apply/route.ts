import { api } from "@/server/http/api";
import type { z } from "zod";
import { reportApplySchema } from "@/lib/ai";
import { applyReport } from "@/server/ai/reports";

/** Apply part of a report locally: next action, plan → child items (undoable), dates. Calendar writes stay off. */
export const POST = api<z.infer<typeof reportApplySchema>, { id: string }>(
  ({ user, params, body, correlationId }) => applyReport(user, params.id, body, correlationId),
  { cap: "work.use", body: reportApplySchema },
);
