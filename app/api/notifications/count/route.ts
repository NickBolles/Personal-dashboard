import { api } from "@/server/http/api";
import { unreadActionableCount } from "@/server/notifications";

export const dynamic = "force-dynamic";

export const GET = api(({ user }) => ({ unread: unreadActionableCount(user.id) }));
