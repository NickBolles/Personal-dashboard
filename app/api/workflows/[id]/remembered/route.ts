import { api } from "@/server/http/api";
import { forgetRemembered, rememberedValues } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(({ user, params }) => ({ values: rememberedValues(user.id, params.id) }), { cap: "work.use" });

/** Forget remembered values (`?field=<id>` for one field, else all). */
export const DELETE = api<undefined, { id: string }>(
  ({ user, params, req, correlationId }) => forgetRemembered({ userId: user.id, correlationId }, params.id, req.nextUrl.searchParams.get("field") ?? undefined),
  { cap: "work.use" },
);
