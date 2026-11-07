import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { listDecisions } from "@/server/work/decisions";
import { validDecisionId } from "@/lib/decision-route";

export const GET = api<undefined, { id: string }>(
  ({ user, params }) => {
    if (!validDecisionId(params.id)) throw new HttpError(404, "not_found", "That decision isn't here");
    const entry = listDecisions(user).entries.find((e) => e.key === params.id);
    if (!entry) throw new HttpError(404, "not_found", "That decision isn't here or has already been answered");
    return { entry };
  },
  { cap: ["work.use", "hermes.chat"] },
);
