import { api } from "@/server/http/api";
import { searchIssues } from "@/integrations/paperclip/service";

export const dynamic = "force-dynamic";

export const GET = api(
  async ({ req }) => {
    const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
    return { results: q.trim().length >= 2 ? await searchIssues(q) : [] };
  },
  { cap: "paperclip.view" },
);
