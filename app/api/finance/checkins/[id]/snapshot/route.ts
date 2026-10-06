import { z } from "zod";
import { api } from "@/server/http/api";
import { resnapshot } from "@/server/finance/checkins";
import { version } from "@/lib/finance/schemas";

const schema = z.object({ version });
/** Re-bind the latest balances (blocked while a refresh is running). */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    resnapshot(params.id, body.version, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
