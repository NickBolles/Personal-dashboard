import { api } from "@/server/http/api";
import { feedbackPatchSchema, type FeedbackPatch } from "@/lib/feedback";
import { deleteFeedback, feedbackId, patchFeedback } from "@/server/feedback/store";
export const dynamic = "force-dynamic";

export const PATCH = api<FeedbackPatch, { id: string }>(
  ({ user, body, params, correlationId }) => ({ feedback: patchFeedback(user, feedbackId(params.id), body, correlationId) }),
  { cap: "hermes.chat", body: feedbackPatchSchema },
);
export const DELETE = api<undefined, { id: string }>(({ user, params, correlationId }) => deleteFeedback(user, feedbackId(params.id), correlationId), {
  cap: "hermes.chat",
});
