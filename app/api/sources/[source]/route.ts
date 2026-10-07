import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { cachedSource, refreshSource, scopeResult, sourceVisible } from "@/server/sources";
import { ACTION_SOURCES, type ActionSource } from "@/lib/contracts";

export const dynamic = "force-dynamic";

/** Source detail for its own page (Todos, Skylight, Home…). */
export const GET = api<undefined, { source: string }>(async ({ params, req, user }) => {
  const s = params.source as ActionSource;
  if (!ACTION_SOURCES.includes(s) || !sourceVisible(user, s)) throw new HttpError(404, "unknown_source", "Unknown source");
  return scopeResult(user, req.nextUrl.searchParams.get("cached") === "1" ? cachedSource(s) : await refreshSource(s));
});
