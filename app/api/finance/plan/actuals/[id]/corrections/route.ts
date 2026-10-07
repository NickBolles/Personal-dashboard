import { z } from "zod";
import { api } from "@/server/http/api";
import { correctActual } from "@/server/finance/plan";
import { cents } from "@/lib/finance/schemas";

const schema = z.object({ fundId: z.string().max(40).nullable(), amount: cents, note: z.string().trim().min(1, "Say why").max(500) });
/** An audited reallocation of an actual (history is never edited). */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => ({ id: correctActual(params.id, body, user.id, correlationId) }),
  {
    cap: "finance.edit",
    body: schema,
  },
);
