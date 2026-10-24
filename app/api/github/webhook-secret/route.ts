import { api } from "@/server/http/api";
import { regenerateWebhookSecret } from "@/server/work/github-connections";

/** Generate (or replace) the webhook secret. The plaintext is in this response only. */
export const POST = api(({ user, correlationId }) => regenerateWebhookSecret(user, correlationId), { cap: "admin" });
