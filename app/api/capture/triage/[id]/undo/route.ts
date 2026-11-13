import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { undoTriage } from "@/server/capture/triage";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** Undo what capture triage did in Skylight (24 h); the item goes back to captured. */
export const POST = api<undefined, { id: string }>(
  async ({ params, user, correlationId }) => {
    const id = decode(params.id);
    if (!ID.test(id)) throw new HttpError(404, "not_found", "Not found");
    if (!user.capabilities.has("skylight.write")) throw new HttpError(403, "forbidden", "You don't have access to that.");
    return { triage: await undoTriage(user, id, correlationId) };
  },
  { cap: "work.use" },
);
