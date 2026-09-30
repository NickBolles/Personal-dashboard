import { api } from "@/server/http/api";
import { listNotifications, unreadActionableCount } from "@/server/notifications";

export const dynamic = "force-dynamic";

export const GET = api(({ user, req }) => {
  const filter = req.nextUrl.searchParams.get("filter") === "all" ? "all" : "inbox";
  return { notifications: listNotifications(user.id, filter), unread: unreadActionableCount(user.id) };
});
