import { api } from "@/server/http/api";
import { listReports } from "@/server/ai/reports";

export const dynamic = "force-dynamic";

/** Reports for Today, the dashboard and the widget (?unread=1). */
export const GET = api(
  ({ req, user }) => {
    const q = req.nextUrl.searchParams;
    return { reports: listReports(user.id, { unread: q.get("unread") === "1", limit: Number(q.get("limit") ?? 30) || 30 }) };
  },
  { cap: "work.use" },
);
