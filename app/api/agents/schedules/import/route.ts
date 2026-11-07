import { api } from "@/server/http/api";
import { jobsExportSchema, type JobsExport } from "@/lib/away";
import { importJobs } from "@/server/agents/schedules";
export const dynamic = "force-dynamic";
export const POST = api<JobsExport>(({ user, body, correlationId }) => importJobs(user, body, correlationId), { cap: "admin", body: jobsExportSchema });
