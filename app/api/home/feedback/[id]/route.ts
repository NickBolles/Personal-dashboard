import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { deleteFeedback } from "@/server/home-tuning";

/** Forget one piece of your own feedback. */
export const DELETE = api<undefined, { id: string }>(({ params, user }) => {
  if (!deleteFeedback(user.id, params.id)) throw new HttpError(404, "not_found", "Feedback not found");
  return { ok: true };
});
