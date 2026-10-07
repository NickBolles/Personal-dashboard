import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { ensureYear, getPlan, listYears } from "@/server/finance/plan";

export const dynamic = "force-dynamic";

/** GET /api/finance/plan?year=2026&revision=…&mode=plan|actual|forecast */
export const GET = api(
  ({ req }) => {
    const sp = req.nextUrl.searchParams;
    const years = listYears().map((y) => y.year);
    const year = Number(sp.get("year") ?? years[0] ?? new Date().getFullYear());
    if (!years.includes(year)) return { year, years, revision: null };
    const mode = sp.get("mode") ?? "forecast";
    if (!["plan", "actual", "forecast"].includes(mode)) throw new HttpError(400, "bad_mode", "mode is plan, actual or forecast");
    return getPlan(year, sp.get("revision") ?? undefined, mode as "plan" | "actual" | "forecast");
  },
  { cap: "finance.view" },
);

const schema = z.object({ year: z.number().int().min(2000).max(2100) });
/** Start a plan year (opening positions roll over from the previous year's forecast). */
export const POST = api<z.infer<typeof schema>>(({ body, user, correlationId }) => ({ revisionId: ensureYear(body.year, user.id, correlationId) }), {
  cap: "finance.edit",
  body: schema,
});
