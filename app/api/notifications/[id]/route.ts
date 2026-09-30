import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { transition, unreadActionableCount } from "@/server/notifications";

const bodySchema = z.object({ transition: z.enum(["read", "unread", "dismiss", "restore", "acted"]) });

export const PATCH = api<z.infer<typeof bodySchema>, { id: string }>(
  ({ params, body, user }) => {
    if (!transition(user.id, params.id, body.transition)) throw new HttpError(404, "not_found", "Notification not found");
    return { ok: true, unread: unreadActionableCount(user.id) };
  },
  { body: bodySchema },
);
