import { z } from "zod";
import { api } from "@/server/http/api";
import { track } from "@/integrations/paperclip/service";

const sessionId = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const bodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("link"),
    sessionId,
    issueId: z.string().max(100),
    relationship: z.enum(["originated_from", "related_to", "implements", "blocked_by", "evidence_for"]).optional(),
  }),
  z.object({ mode: z.literal("create"), sessionId, title: z.string().min(3).max(200), description: z.string().max(5000).optional() }),
  z.object({
    mode: z.literal("child"),
    sessionId,
    parentId: z.string().max(100),
    title: z.string().min(3).max(200),
    description: z.string().max(5000).optional(),
  }),
]);

export const POST = api<z.infer<typeof bodySchema>>(({ body, user, correlationId }) => track(body, user.id, correlationId), {
  cap: "paperclip.track",
  body: bodySchema,
});
