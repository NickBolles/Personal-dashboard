import { api } from "@/server/http/api";
import { pushCapabilities } from "@/server/notifications/push";

/** Which push channels work for the signed-in user (FCM configured? phone token? web subscriptions?). */
export const GET = api(({ user }) => pushCapabilities(user.id));
