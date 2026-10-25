import { api } from "@/server/http/api";
import type { z } from "zod";
import { githubAppUpdateSchema } from "@/lib/github";
import { forgetApp, publicApp, setAppAllowlist, setAppWebhookSecret } from "@/server/work/github-app";

export const dynamic = "force-dynamic";

/** Account allowlist for App installations (null = default: token owners + the App owner) and/or a new webhook secret (write-only). */
export const PATCH = api<z.infer<typeof githubAppUpdateSchema>>(
  ({ user, body, correlationId }) => {
    if (body.allowlist !== undefined) setAppAllowlist(user, body.allowlist, correlationId);
    if (body.webhookSecret !== undefined) setAppWebhookSecret(user, body.webhookSecret, correlationId);
    return { app: publicApp() };
  },
  { cap: "admin", body: githubAppUpdateSchema },
);

/** Forget the App's credentials and installations here (delete the App on GitHub yourself). */
export const DELETE = api(({ user, correlationId }) => forgetApp(user, correlationId), { cap: "admin" });
