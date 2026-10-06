import { api } from "@/server/http/api";
import { deleteLink } from "@/integrations/paperclip/service";

/** Removes only Jarvis' relationship record. Paperclip work is never closed or deleted. */
export const DELETE = api<undefined, { id: string }>(
  ({ params, user, correlationId }) => {
    deleteLink(params.id, user.id, correlationId);
    return { ok: true };
  },
  { cap: "paperclip.track" },
);
