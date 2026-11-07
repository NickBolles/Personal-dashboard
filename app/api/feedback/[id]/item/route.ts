import { api } from "@/server/http/api";
import { createItemFromFeedback, feedbackId } from "@/server/feedback/store";
export const dynamic = "force-dynamic";

/** "Create item": a thread under the rating's area linking back to the message (Undo via the returned op). */
export const POST = api<undefined, { id: string }>(
  ({ user, params, correlationId }) => Response.json(createItemFromFeedback(user, feedbackId(params.id), correlationId), { status: 201 }),
  { capAll: ["hermes.chat", "work.use"] },
);
