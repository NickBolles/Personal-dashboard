import { z } from "zod";
import { api } from "@/server/http/api";
import { importCsv } from "@/server/finance/sync";

const schema = z.object({
  kind: z.enum(["balances", "transactions"]),
  csv: z.string().min(1).max(500_000),
  accountId: z.string().max(40).optional(),
});

export const POST = api<z.infer<typeof schema>>(({ body, user, correlationId }) => importCsv(body.kind, body.csv, body.accountId, user.id, correlationId), {
  cap: "finance.edit",
  body: schema,
});
