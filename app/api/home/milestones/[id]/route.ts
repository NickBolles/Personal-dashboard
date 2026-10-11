import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { deleteMilestone } from "@/server/home-tuning";

export const DELETE = api<undefined, { id: string }>(({ params, user }) => {
  if (!deleteMilestone(user.id, params.id)) throw new HttpError(404, "not_found", "Saved date not found");
  return { ok: true };
});
