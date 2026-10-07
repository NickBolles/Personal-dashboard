import { z } from "zod";
import { api } from "@/server/http/api";
import { listCheckins, startCheckin } from "@/server/finance/checkins";
import { thisMonth } from "@/server/finance/common";

export const dynamic = "force-dynamic";

export const GET = api(
  () => ({
    month: thisMonth(),
    checkins: listCheckins().map(({ id, month, status, closedAt, closedBy, createdAt }) => ({ id, month, status, closedAt, closedBy, createdAt })),
  }),
  { cap: "finance.view" },
);

const schema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });
export const POST = api<z.infer<typeof schema>>(({ body, user, correlationId }) => ({ id: startCheckin(body.month, user.id, correlationId) }), {
  cap: "finance.edit",
  body: schema,
});
