import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { createInvite } from "@/server/people";
import { getUser } from "@/server/auth";

/** A fresh one-time invite (the previous one stops working). */
export const POST = api<undefined, { id: string }>(
  ({ params, user, correlationId }) => {
    if (!getUser(params.id)) throw new HttpError(404, "not_found", "Person not found");
    const invite = createInvite(params.id, user.id);
    audit({ actor: user.id, action: "people.invite", sourceRecord: params.id, result: "ok", correlationId });
    return { invite };
  },
  { cap: "admin" },
);
