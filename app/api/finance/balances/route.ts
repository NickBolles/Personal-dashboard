import { z } from "zod";
import { api } from "@/server/http/api";
import { enterBalances } from "@/server/finance/sync";
import { cents, statementInput } from "@/lib/finance/schemas";

const schema = z.object({
  entries: z
    .array(
      z.object({
        accountId: z.string().min(1).max(40),
        balance: cents,
        asOf: z.string().datetime().nullable().optional(),
        semantics: z.enum(["current", "available", "statement"]).optional(),
        statement: statementInput.optional(),
      }),
    )
    .min(1)
    .max(50),
});

/** Manual balance entry (always available; also the fallback when the connector isn't validated). */
export const POST = api<z.infer<typeof schema>>(({ body, user, correlationId }) => ({ runId: enterBalances(body.entries, user.id, correlationId) }), {
  cap: "finance.edit",
  body: schema,
});
