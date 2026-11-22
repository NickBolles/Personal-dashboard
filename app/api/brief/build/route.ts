import type { z } from "zod";
import { api } from "@/server/http/api";
import { briefBuildSchema } from "@/lib/brief";
import { BRIEF_CAP, getBriefView, startBuild } from "@/server/brief";

/** Ask the AI layer to (re)write today's brief. Queues a job; the page polls `GET /api/brief` for the result. */
export const POST = api<z.infer<typeof briefBuildSchema>>(
  async ({ user, body, correlationId }) => {
    await startBuild(user, body, correlationId);
    return getBriefView(user);
  },
  { body: briefBuildSchema, cap: BRIEF_CAP },
);
