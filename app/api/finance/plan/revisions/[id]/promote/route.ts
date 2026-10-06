import { z } from "zod";
import { api } from "@/server/http/api";
import { promoteRevision } from "@/server/finance/plan";
import { version } from "@/lib/finance/schemas";

const schema = z.object({ version });
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    promoteRevision(params.id, body.version, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
