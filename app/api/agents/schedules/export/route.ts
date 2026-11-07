import { api } from "@/server/http/api";
import { exportJobs } from "@/server/agents/schedules";
export const dynamic = "force-dynamic";
export const GET = api(
  ({ user }) =>
    Response.json(exportJobs(user), { headers: { "content-disposition": 'attachment; filename="jarvis-schedules.json"', "cache-control": "no-store" } }),
  { cap: "admin" },
);
