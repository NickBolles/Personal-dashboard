import { z } from "zod";
import { api } from "@/server/http/api";
import { closeCheckin } from "@/server/finance/checkins";
import { version } from "@/lib/finance/schemas";

const schema = z.object({ version, note: z.string().max(1000).optional() });
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    closeCheckin(params.id, body.version, body.note, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
