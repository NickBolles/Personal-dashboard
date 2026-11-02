import { api } from "@/server/http/api";
import { workflowHistory } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

/** Session history + plain-count stats for one workflow. Filters: speaker, place, series, book. */
export const GET = api<undefined, { id: string }>(
  ({ user, params, req }) => {
    const q = req.nextUrl.searchParams;
    const f = (k: string) => q.get(k)?.slice(0, 120) || undefined;
    return workflowHistory(user.id, params.id, { speaker: f("speaker"), place: f("place"), series: f("series"), book: f("book") });
  },
  { cap: "work.use" },
);
