import { api } from "@/server/http/api";
import { listJobs } from "@/server/ai/jobs";

export const dynamic = "force-dynamic";

export const GET = api(
  ({ req, user }) => {
    const q = req.nextUrl.searchParams;
    return {
      jobs: listJobs(user.id, { state: q.get("state") ?? undefined, subject: q.get("subject") ?? undefined, limit: Number(q.get("limit") ?? 50) || 50 }),
    };
  },
  { capAll: ["work.use", "work.ai"] },
);
