import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { cancelImprovement, IMPROVE_CAPS } from "@/server/brief/improve";

export const dynamic = "force-dynamic";

/** Undo an "Improve" request: stops the agent if it is still going and archives the item and its conversation. */
export const DELETE = api<undefined, { id: string }>(
  ({ user, params, correlationId }) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(params.id)) throw new HttpError(400, "bad_id", "Invalid id");
    return cancelImprovement(user, params.id, correlationId);
  },
  { capAll: [...IMPROVE_CAPS] },
);
