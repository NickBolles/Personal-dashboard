import { api } from "@/server/http/api";
import type { z } from "zod";
import { githubSettingsSchema } from "@/lib/github";
import { githubSettings, setPollMinutes } from "@/server/work/github-connections";
import { pollerStatus, startWorkGithubPoller } from "@/server/work/github-poller";
import { requestOrigin } from "@/server/work/github-app";

export const dynamic = "force-dynamic";

/** Settings → Connections → GitHub (admin): App + installations and connections (no secrets), webhook status, poll interval. */
export const GET = api(({ req }) => githubSettings(pollerStatus(), requestOrigin(req)), { cap: "admin" });

export const PATCH = api<z.infer<typeof githubSettingsSchema>>(
  ({ req, user, body, correlationId }) => {
    setPollMinutes(user, body.pollMinutes, correlationId);
    startWorkGithubPoller();
    return githubSettings(pollerStatus(), requestOrigin(req));
  },
  { cap: "admin", body: githubSettingsSchema },
);
