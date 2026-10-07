import { z } from "zod";
import { api } from "@/server/http/api";
import { createRevision } from "@/server/finance/plan";

const schema = z.object({
  year: z.number().int().min(2000).max(2100),
  name: z.string().trim().min(1).max(80),
  changeNote: z.string().trim().min(1, "A change note is required").max(1000),
  basedOnId: z.string().max(40).optional(),
});
/** New revisions copy the active one (or another) and start hypothetical. */
export const POST = api<z.infer<typeof schema>>(({ body, user, correlationId }) => ({ id: createRevision(body.year, body, user.id, correlationId) }), {
  cap: "finance.edit",
  body: schema,
});
