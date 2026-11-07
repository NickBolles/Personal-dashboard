import { api } from "@/server/http/api";
import { feedbackFilterSchema, rateInputSchema, type RateInput } from "@/lib/feedback";
import { listFeedback, rateMessage } from "@/server/feedback/store";
export const dynamic = "force-dynamic";

/** The rater's own feedback, newest first (filters: rating, status, reason, profile, areaId, sessionId). */
export const GET = api(
  ({ user, req }) => {
    const q = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    return listFeedback(user, feedbackFilterSchema.parse(q));
  },
  { cap: "hermes.chat" },
);

/** Rate (or re-rate) one assistant message. */
export const POST = api<RateInput>(({ user, body, correlationId }) => Response.json({ feedback: rateMessage(user, body, correlationId) }, { status: 201 }), {
  cap: "hermes.chat",
  body: rateInputSchema,
});
