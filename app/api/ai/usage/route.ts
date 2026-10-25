import { api } from "@/server/http/api";
import { usage, usageCsv } from "@/server/ai/budget";

export const dynamic = "force-dynamic";

/** Spend ledger: admins see the household, everyone else their own jobs. ?format=csv|json downloads. */
export const GET = api(
  ({ req, user }) => {
    const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
    const scope = user.capabilities.has("admin") ? null : user.id;
    const format = req.nextUrl.searchParams.get("format");
    if (format === "csv")
      return new Response(usageCsv(scope, days), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="jarvis-ai-usage-${days}d.csv"`,
          "cache-control": "no-store",
        },
      });
    const body = usage(scope, days);
    if (format === "json")
      return new Response(JSON.stringify(body, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="jarvis-ai-usage-${days}d.json"`,
          "cache-control": "no-store",
        },
      });
    return body;
  },
  { cap: "work.ai" },
);
