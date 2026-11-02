import { z } from "zod";
import { api } from "@/server/http/api";
import { proposeSummary, setSummary } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

/** Agent drafts the end-of-session summary (a proposal; nothing is accepted until PUT). */
export const POST = api<undefined, { runId: string }>(
  ({ user, params, correlationId }) => proposeSummary(user, { userId: user.id, correlationId }, params.runId),
  { capAll: ["work.use", "work.ai"] },
);

const body = z.object({ summary: z.string().max(4000).nullable() }).strict();

/** Owner accepts (optionally edited) or clears the summary. Local run state. */
export const PUT = api<z.infer<typeof body>, { runId: string }>(
  ({ user, params, body, correlationId }) => setSummary({ userId: user.id, correlationId }, params.runId, body),
  { cap: "work.use", body },
);
