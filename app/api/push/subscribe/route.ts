import { z } from "zod";
import { api } from "@/server/http/api";
import { isAllowedPushEndpoint, listSubscriptions, removeSubscription, saveSubscription } from "@/server/notifications/push";

const subSchema = z.object({
  endpoint: z.string().url().max(2000).refine(isAllowedPushEndpoint, "Not a browser push service endpoint"),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  /** Set by the client when it runs inside the Jarvis Android app. */
  source: z.enum(["android-app", "browser"]).optional(),
});

export const GET = api(({ user }) => ({
  subscriptions: listSubscriptions(user.id).map((s) => ({
    endpoint: s.endpoint,
    userAgent: s.userAgent,
    source: s.source,
    createdAt: s.createdAt,
    lastSuccessAt: s.lastSuccessAt,
  })),
}));

export const POST = api<z.infer<typeof subSchema>>(
  ({ body, user, req }) => {
    saveSubscription(user.id, body, req.headers.get("user-agent"), body.source ?? "browser");
    return { ok: true };
  },
  { body: subSchema },
);

const delSchema = z.object({ endpoint: z.string().max(2000) });
export const DELETE = api<z.infer<typeof delSchema>>(
  ({ body, user }) => {
    removeSubscription(body.endpoint, user.id);
    return { ok: true };
  },
  { body: delSchema },
);
