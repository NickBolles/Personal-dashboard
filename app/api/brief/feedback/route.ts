import type { z } from "zod";
import { api } from "@/server/http/api";
import { briefFeedbackSchema } from "@/lib/brief";
import { BRIEF_CAP } from "@/server/brief";
import { setFeedback } from "@/server/brief/store";

/**
 * A reaction to the brief, a pick or a card. Private to the person, stored in
 * Jarvis only, and reversible: `verdict: null` clears it (the response carries
 * the previous value so the client can offer Undo).
 */
export const POST = api<z.infer<typeof briefFeedbackSchema>>(({ user, body }) => setFeedback(user.id, body), { body: briefFeedbackSchema, cap: BRIEF_CAP });
