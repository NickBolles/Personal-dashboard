import { api } from "@/server/http/api";
import { listJobs, areaPolicyFor } from "@/server/ai/jobs";
import { listReports } from "@/server/ai/reports";
import { getAiSettings } from "@/server/ai/settings";
import { getDetail } from "@/server/work/store";
import type { ItemAiResponse } from "@/lib/ai";

export const dynamic = "force-dynamic";

/** Jobs (last 10) and reports (non-archived, newest first) for an item, plus whether AI actions are offered here. */
export const GET = api<undefined, { id: string }>(
  ({ user, params }): ItemAiResponse => {
    getDetail(user.id, params.id);
    const policy = areaPolicyFor(user.id, params.id);
    const enabled = getAiSettings().enabled;
    return {
      jobs: listJobs(user.id, { subject: params.id, limit: 10 }),
      reports: listReports(user.id, { subjectId: params.id }),
      policy: !enabled
        ? { allowed: false, reason: "ai_disabled" }
        : policy === "allowed"
          ? { allowed: true }
          : { allowed: false, reason: policy === "excluded" ? "ai_excluded_area" : "triage_only" },
    };
  },
  { cap: "work.use" },
);
