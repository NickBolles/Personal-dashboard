import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { cachedSource, refreshSource } from "@/server/sources";
import { ACTION_SOURCES, type ActionSource } from "@/lib/contracts";

export const dynamic = "force-dynamic";

/** Source detail for its own page (Todos, Skylight, Home…). */
export const GET = api<undefined, { source: string }>(async ({ params, req }) => {
  if (!ACTION_SOURCES.includes(params.source as ActionSource)) throw new HttpError(404, "unknown_source", "Unknown source");
  const s = params.source as ActionSource;
  return req.nextUrl.searchParams.get("cached") === "1" ? cachedSource(s) : refreshSource(s);
});
