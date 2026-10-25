import { z } from "zod";
import { api } from "@/server/http/api";
import { listSessions } from "@/server/assistant";
import { startConversation } from "@/server/areas";
import { ASSISTANT_BACKENDS } from "@/lib/assistant";

export const dynamic = "force-dynamic";

export const GET = api(
  async ({ req, user }) => {
    const rawOffset = req.nextUrl.searchParams.get("offset");
    const offset =
      rawOffset === null
        ? undefined
        : z
            .string()
            .regex(/^\d{1,7}$/)
            .transform(Number)
            .pipe(z.number().int().max(1_000_000))
            .parse(rawOffset);
    return listSessions(user, { includeArchived: req.nextUrl.searchParams.get("archived") === "1", offset, signal: req.signal });
  },
  {
    cap: "hermes.chat",
  },
);

/**
 * New conversation; `backend` picks Hermes or Claude (default: the area's, else the household setting).
 * With Areas it lands in Miscellaneous, or under `areaId` (an area or item you own) — no filing step.
 */
export const POST = api(({ body, user, correlationId }) => startConversation(user, body, correlationId), {
  body: z.object({
    title: z.string().max(200).optional(),
    backend: z.enum(ASSISTANT_BACKENDS).optional(),
    areaId: z.string().min(1).max(80).nullable().optional(),
  }),
  cap: "hermes.chat",
});
