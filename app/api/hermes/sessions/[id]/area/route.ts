import { api } from "@/server/http/api";
import { conversationAreaContext } from "@/server/areas";

export const dynamic = "force-dynamic";

/** Where this conversation sits in the Areas tree (header chip), with filing suggestions and its area's defaults. `?title=` feeds the suggestions. */
export const GET = api<undefined, { id: string }>(
  ({ req, params, user }) => conversationAreaContext(user, params.id, (req.nextUrl.searchParams.get("title") ?? "").slice(0, 200)),
  { cap: "hermes.chat" },
);
