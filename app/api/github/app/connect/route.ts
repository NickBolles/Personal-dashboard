import { api } from "@/server/http/api";
import type { z } from "zod";
import { githubAppConnectSchema } from "@/lib/github";
import { connectExistingApp } from "@/server/work/github-app";
import { startWorkGithubPoller } from "@/server/work/github-poller";

export const dynamic = "force-dynamic";

/**
 * "Connect existing GitHub App" (admin): App ID + private key (+ webhook
 * secret), write-only, verified with the App JWT (GET /app) before storing.
 * The response carries only the public App summary.
 */
export const POST = api<z.infer<typeof githubAppConnectSchema>>(
  async ({ user, body, correlationId }) => {
    const app = await connectExistingApp(user, body, correlationId);
    startWorkGithubPoller();
    return { app };
  },
  { cap: "admin", body: githubAppConnectSchema },
);
