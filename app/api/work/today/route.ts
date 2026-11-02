import { api } from "@/server/http/api";
import { today } from "@/server/work/today";

export const dynamic = "force-dynamic";

/** Today: KPIs, things to continue, proof due, ready to settle, overdue (local data only). */
// ?tag=&assignee= filter before the section limits (#155)
export const GET = api(
  ({ user, req }) => {
    const sp = req.nextUrl.searchParams;
    return today(user.id, new Date(), { tag: sp.get("tag")?.slice(0, 100) || null, assignee: sp.get("assignee")?.slice(0, 200) || null });
  },
  { cap: "work.use" },
);
