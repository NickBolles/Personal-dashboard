import { z } from "zod";
import { api } from "@/server/http/api";
import { respondApproval } from "@/integrations/hermes/service";
import { getDb, schema } from "@/server/db";
import { and, eq, like } from "drizzle-orm";

const bodySchema = z.object({ choice: z.enum(["once", "session", "always", "deny"]), requestId: z.string().max(256).optional() });

export const POST = api<z.infer<typeof bodySchema>, { runId: string }>(
  async ({ params, body, user, correlationId }) => {
    const res = await respondApproval(user, params.runId, body, correlationId);
    // Answering in-app acts on the matching alert.
    getDb()
      .update(schema.notifications)
      .set({ actedAt: new Date().toISOString(), readAt: new Date().toISOString() })
      .where(and(eq(schema.notifications.userId, user.id), like(schema.notifications.dedupeKey, `approval:${params.runId}:%`)))
      .run();
    return res;
  },
  { cap: "hermes.approve", body: bodySchema },
);
