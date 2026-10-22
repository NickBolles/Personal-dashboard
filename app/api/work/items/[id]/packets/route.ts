import { api } from "@/server/http/api";
import type { z } from "zod";
import { packetSchema } from "@/lib/work";
import { createPacket } from "@/server/work/store";

/** Start focused work / hand off: a new immutable packet version. */
export const POST = api<z.infer<typeof packetSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ packet: createPacket(user, params.id, body, correlationId) }),
  {
    cap: "work.use",
    body: packetSchema,
  },
);
