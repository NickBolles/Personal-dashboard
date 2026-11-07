import { api } from "@/server/http/api";
import { jobPatchSchema, type JobPatch } from "@/lib/away";
import { assertAwayOwner, patchJob, deleteJob, scheduleId } from "@/server/agents/schedules";
export const dynamic = "force-dynamic";
export const PATCH = api<JobPatch, { id: string }>(
  ({ user, body, params, correlationId }) => {
    assertAwayOwner(user);
    return { job: patchJob(user, scheduleId(params.id), body, correlationId) };
  },
  { cap: "admin", body: jobPatchSchema },
);
export const DELETE = api<undefined, { id: string }>(
  ({ user, params, correlationId }) => {
    assertAwayOwner(user);
    return deleteJob(user, scheduleId(params.id), correlationId);
  },
  { cap: "admin" },
);
