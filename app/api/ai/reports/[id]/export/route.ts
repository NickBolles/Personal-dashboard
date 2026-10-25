import { api } from "@/server/http/api";
import { exportReport } from "@/server/ai/reports";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(
  ({ req, user, params }) => {
    const format = req.nextUrl.searchParams.get("format") === "json" ? "json" : "md";
    const out = exportReport(user.id, params.id, format);
    return new Response(out.body, {
      headers: {
        "content-type": out.type,
        "content-disposition": `attachment; filename="jarvis-report-${params.id.replace(/[^A-Za-z0-9_-]/g, "")}.${out.ext}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
  { cap: "work.use" },
);
