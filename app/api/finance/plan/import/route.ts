import { z } from "zod";
import { api } from "@/server/http/api";
import { importProjectionBlock } from "@/server/finance/plan";

const schema = z.object({
  year: z.number().int().min(2000).max(2100),
  name: z.string().trim().min(1).max(80),
  tab: z.string().trim().min(1).max(80),
  block: z.string().trim().min(1).max(80),
  range: z.string().trim().min(1).max(40),
  csv: z.string().min(1).max(300_000),
});
/** One-time spreadsheet migration: imports a block as a hypothetical, unreconciled revision with provenance. */
export const POST = api<z.infer<typeof schema>>(({ body, user, correlationId }) => importProjectionBlock(body, user.id, correlationId), {
  cap: "finance.edit",
  body: schema,
});
