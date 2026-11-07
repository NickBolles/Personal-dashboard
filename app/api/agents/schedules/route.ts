import { api } from "@/server/http/api";
import { jobInputSchema, type JobInput } from "@/lib/away";
import { assertAwayOwner, createJob, listSchedules } from "@/server/agents/schedules";
export const dynamic = "force-dynamic";
export const GET = api(({ user }) => listSchedules(user), { cap: "admin" });
export const POST = api<JobInput>(
  ({ user, body, correlationId }) => {
    assertAwayOwner(user);
    return Response.json({ job: createJob(user, body, correlationId) }, { status: 201 });
  },
  { cap: "admin", body: jobInputSchema },
);
