import { api } from "@/server/http/api";
import { briefStepSchema, type BriefStepInput } from "@/lib/brief";
import { BRIEF_CAP } from "@/server/brief";
import { setTick } from "@/server/brief/store";

/**
 * Tick or untick one small step on a card of the person's own brief. Private to
 * the person, stored on the brief only (no task is created), and its own undo:
 * send `done: false`. The next build is told how many were ticked.
 */
export const POST = api<BriefStepInput>(({ user, body }) => setTick(user.id, body), { body: briefStepSchema, cap: BRIEF_CAP });
