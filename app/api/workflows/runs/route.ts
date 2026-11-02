import { z } from "zod";
import { api } from "@/server/http/api";
import { listRuns, startRun } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

export const GET = api(({ user, req }) => ({ runs: listRuns(user.id, req.nextUrl.searchParams.get("workflowId") ?? undefined) }), { cap: "work.use" });

const body = z
  .object({
    workflowId: z.string().min(1).max(80),
    values: z.record(z.string().max(40), z.unknown()),
    triggeredBy: z.enum(["palette", "share", "schedule", "area", "resume", "gallery"]).optional(),
  })
  .strict();

/** Submit the start form → live run (capture seeded from the form, values remembered). */
export const POST = api<z.infer<typeof body>>(({ user, body, correlationId }) => startRun({ userId: user.id, correlationId }, body), {
  capAll: ["work.use", "hermes.chat"],
  body,
});
