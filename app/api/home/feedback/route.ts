import { z } from "zod";
import { api } from "@/server/http/api";
import { CATEGORY_PATTERN, FEEDBACK_VERDICTS } from "@/lib/attention";
import { recordFeedback } from "@/server/home-tuning";
import { adapterContext, sourceVisible } from "@/server/sources";

const bodySchema = z.object({
  idempotencyKey: z.string().min(8).max(100),
  target: z.object({
    kind: z.enum(["action", "assist"]),
    id: z.string().min(3).max(300),
    category: z.string().regex(CATEGORY_PATTERN),
  }),
  verdict: z.enum(FEEDBACK_VERDICTS),
  /** "Wrong assumption": what was wrong, in the person's words */
  correction: z.string().max(500).optional(),
  /** "Not now": until when (default: start of tomorrow, local) */
  snoozeUntil: z.iso.datetime({ offset: true }).optional(),
  /** what the card said when the person reacted (stored with the feedback) */
  provenance: z.object({
    version: z.number().int().min(1).max(100),
    fingerprint: z.string().min(1).max(128),
    why: z.array(z.string().max(200)).max(6),
    sources: z.array(z.string().max(40)).max(8),
  }),
});

/**
 * Feedback on a Home card. Jarvis-local and per person: it changes how this
 * person's Home ranks, never the item in its source. Idempotent per key.
 */
export const POST = api<z.infer<typeof bodySchema>>(({ body, user }) => recordFeedback(user, body, { timezone: adapterContext().timezone, sourceVisible }), {
  body: bodySchema,
});
