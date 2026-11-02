import { api } from "@/server/http/api";
import { forgetPlace } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

export const DELETE = api<undefined, { placeId: string }>(
  ({ user, params, correlationId }) => forgetPlace({ userId: user.id, correlationId }, params.placeId),
  { cap: "work.use" },
);
