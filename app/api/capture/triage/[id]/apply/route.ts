import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { applySuggestion } from "@/server/capture/triage";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** "Do it": the owner confirms a suggested low-risk action (risky types are refused). */
export const POST = api<undefined, { id: string }>(
  async ({ params, user, correlationId }) => {
    const id = decode(params.id);
    if (!ID.test(id)) throw new HttpError(404, "not_found", "Not found");
    if (!user.capabilities.has("skylight.write")) throw new HttpError(403, "forbidden", "You don't have access to that.");
    void correlationId;
    return { triage: applySuggestion(user, id) };
  },
  { cap: "work.use" },
);
