import { api } from "@/server/http/api";
import { handleGithubWebhook } from "@/server/work/github-webhook";

export const dynamic = "force-dynamic";

/**
 * Read-only GitHub webhook receiver. Public (no session) and CSRF-exempt: the
 * X-Hub-Signature-256 HMAC is the only credential (server/work/github-webhook.ts).
 */
export const POST = api(({ req, correlationId }) => handleGithubWebhook(req, correlationId), { public: true, csrf: false });
