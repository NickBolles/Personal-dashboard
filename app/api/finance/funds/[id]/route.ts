import { z } from "zod";
import { api } from "@/server/http/api";
import { updateFund } from "@/server/finance/funds";
import { version } from "@/lib/finance/schemas";

const schema = z.object({ name: z.string().trim().min(1).max(60).optional(), protected: z.boolean().optional(), archived: z.boolean().optional(), version });
export const PATCH = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    updateFund(params.id, body, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
