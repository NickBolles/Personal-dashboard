import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { CONTEXT_SOURCES, sourceContext, type ContextSource } from "@/server/context";

export const dynamic = "force-dynamic";

/** Preview what "Ask about <source>" attaches: GET /api/context?source=skylight */
export const GET = api(async ({ req }) => {
  const source = req.nextUrl.searchParams.get("source") ?? "overview";
  if (!(CONTEXT_SOURCES as readonly string[]).includes(source)) throw new HttpError(400, "unknown_source", "Unknown context source");
  const text = await sourceContext(source as ContextSource);
  return { source, text, lines: text.split("\n").length };
});
