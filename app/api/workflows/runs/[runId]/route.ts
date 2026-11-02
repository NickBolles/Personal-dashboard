import { z } from "zod";
import { api } from "@/server/http/api";
import { getRun, linkConversation, patchRun } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { runId: string }>(({ user, params }) => getRun(user.id, params.runId), { cap: "work.use" });

const body = z.union([
  z.object({ by: z.literal("user"), ops: z.array(z.unknown()).max(40), source: z.enum(["quickAdd", "edit", "form:mid", "outline"]).optional() }).strict(),
  z.object({ by: z.literal("agent"), text: z.string().max(64_000) }).strict(),
  z.object({ conversationId: z.string().min(1).max(120) }).strict(),
]);

/**
 * Capture changes (jarvis-capture@1): user ops, or an assistant reply whose
 * fenced ops are validated against the pinned schema and applied with Undo (D2).
 */
export const PATCH = api<z.infer<typeof body>, { runId: string }>(
  ({ user, params, body, correlationId }) => {
    const ctx = { userId: user.id, correlationId };
    if ("conversationId" in body) return linkConversation(ctx, params.runId, body.conversationId);
    return patchRun(ctx, params.runId, body);
  },
  { capAll: ["work.use", "hermes.chat"], body },
);
