import { z } from "zod";
import { api } from "@/server/http/api";
import { resolveProposals } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

const body = z.object({ accept: z.array(z.number().int().min(0).max(19)).max(20), clear: z.boolean().optional() }).strict();

/** Accept (by index) or clear AI-proposed form values (§12.8, never applied without a tap). */
export const POST = api<z.infer<typeof body>, { runId: string }>(
  ({ user, params, body, correlationId }) => resolveProposals({ userId: user.id, correlationId }, params.runId, body),
  {
    cap: "work.use",
    body,
  },
);
