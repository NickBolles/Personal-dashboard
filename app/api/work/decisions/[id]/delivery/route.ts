import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { getDb } from "@/server/db";
import { findDecision, toDecision } from "@/server/work/decision-store";
import { decodeDecisionId } from "@/lib/decision-route";

export const dynamic = "force-dynamic";

/** Where an answer is on its way to the agent (a receipt reads this after its Undo window). */
export const GET = api<undefined, { id: string }>(
  ({ user, params }) => {
    const row = findDecision(getDb(), user.id, decodeDecisionId(params.id));
    if (!row) throw new HttpError(404, "not_found", "That decision isn't here");
    return { delivery: toDecision(row).delivery ?? null };
  },
  { cap: ["work.use", "hermes.chat"] },
);
