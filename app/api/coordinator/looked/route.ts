import { z } from "zod";
import { LOOK_SURFACES } from "@/lib/cw-runs";
import { api } from "@/server/http/api";
import { lastLooked, markLooked } from "@/server/work/run-events";

export const GET = api(({ user }) => ({ lastLooked: lastLooked(user.id) }), { cap: "work.use" });

export const POST = api(({ user, body }) => ({ lastLooked: markLooked(user.id, body.surface, body.at) }), {
  cap: "work.use",
  body: z.object({ surface: z.enum(LOOK_SURFACES), at: z.string().datetime({ offset: true }).optional() }).strict(),
});
