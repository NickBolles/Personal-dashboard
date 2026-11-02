import { z } from "zod";
import { api } from "@/server/http/api";
import { undoRun } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

const body = z.object({ entries: z.array(z.string().max(120)).max(50).default([]) }).strict();

/** Undo capture changes (newest first); empty = the latest undoable change. */
export const POST = api<z.infer<typeof body>, { runId: string }>(
  ({ user, params, body, correlationId }) => undoRun({ userId: user.id, correlationId }, params.runId, body.entries),
  {
    cap: "work.use",
    body,
  },
);
