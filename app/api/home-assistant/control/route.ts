import { z } from "zod";
import { api } from "@/server/http/api";
import { executeControl } from "@/integrations/home-assistant/controls";
import { refreshSource } from "@/server/sources";

const bodySchema = z.object({
  entityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
  service: z.string().regex(/^[a-z_]+$/),
  stateToken: z.string().min(4).max(64),
  confirmed: z.literal(true),
});

export const POST = api<z.infer<typeof bodySchema>>(
  async ({ body, user, correlationId }) => {
    const res = await executeControl(body, user.id, correlationId);
    await refreshSource("home_assistant").catch(() => undefined);
    return res;
  },
  { body: bodySchema },
);
