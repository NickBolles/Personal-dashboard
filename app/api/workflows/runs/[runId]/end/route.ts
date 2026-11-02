import { z } from "zod";
import { api } from "@/server/http/api";
import { endWithForm } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

const body = z
  .object({ values: z.record(z.string().max(40), z.unknown()).optional() })
  .strict()
  .optional();

/** End session, filing the optional end form first (local, undoable). Never settles anything. */
export const POST = api<z.infer<typeof body>, { runId: string }>(
  ({ user, params, body, correlationId }) => endWithForm({ userId: user.id, correlationId }, params.runId, body?.values),
  { cap: "work.use", body },
);
