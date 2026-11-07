import { z } from "zod";
import { api } from "@/server/http/api";
import { assertAwayOwner, scheduleId } from "@/server/agents/schedules";
import { runJobNow } from "@/server/agents/scheduler";
import { audit } from "@/server/audit";
const bodySchema = z.object({ confirm: z.literal(true) }).strict();
export const dynamic = "force-dynamic";
export const POST = api<z.infer<typeof bodySchema>, { id: string }>(
  async ({ user, params, correlationId }) => {
    assertAwayOwner(user);
    const id = scheduleId(params.id);
    const run = await runJobNow(user, id);
    audit({ actor: user.id, action: "agents.schedules.run", source: "agents", sourceRecord: id, result: "ok", correlationId });
    return Response.json({ run }, { status: 202 });
  },
  { cap: "admin", body: bodySchema },
);
