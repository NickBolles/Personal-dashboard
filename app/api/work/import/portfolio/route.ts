import { api } from "@/server/http/api";
import { portfolioImportSchema } from "@/lib/portfolio-import";
import { importPortfolioMap } from "@/server/work/portfolio-import";

export const dynamic = "force-dynamic";

/**
 * Portfolio map import (Phase 4): `{ map, apply? }`. Without `apply` it is a dry
 * run that returns the plan; with `apply: true` it adds items/links/tags in one
 * transaction and returns an Undo op. Never deletes, settles or touches Finance.
 */
export const POST = api(({ user, body, correlationId }) => importPortfolioMap(user, body.map, { apply: body.apply, aliases: body.aliases }, correlationId), {
  cap: "work.use",
  body: portfolioImportSchema,
});
