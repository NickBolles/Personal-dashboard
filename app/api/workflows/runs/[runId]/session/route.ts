import { z } from "zod";
import { api } from "@/server/http/api";
import { editSession } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

const body = z.object({ values: z.record(z.string().max(40), z.unknown()) }).strict();

/** Edit session (#132): REPLACE ops for changed scalar fields; list items are edited individually. */
export const PATCH = api<z.infer<typeof body>, { runId: string }>(
  ({ user, params, body, correlationId }) => editSession({ userId: user.id, correlationId }, params.runId, body.values),
  { cap: "work.use", body },
);
