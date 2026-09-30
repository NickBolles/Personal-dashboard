import { api } from "@/server/http/api";
import { markAllRead } from "@/server/notifications";

export const POST = api(({ user }) => {
  markAllRead(user.id);
  return { ok: true, unread: 0 };
});
