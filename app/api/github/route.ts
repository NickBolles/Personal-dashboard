import { api } from "@/server/http/api";
import type { z } from "zod";
import { githubSettingsSchema } from "@/lib/github";
import { githubSettings, setPollMinutes } from "@/server/work/github-connections";
import { pollerStatus, startWorkGithubPoller } from "@/server/work/github-poller";

export const dynamic = "force-dynamic";

/** Settings → Connections → GitHub (admin): connections (no tokens), webhook status, poll interval. */
export const GET = api(() => githubSettings(pollerStatus()), { cap: "admin" });

export const PATCH = api<z.infer<typeof githubSettingsSchema>>(
  ({ user, body, correlationId }) => {
    setPollMinutes(user, body.pollMinutes, correlationId);
    startWorkGithubPoller();
    return githubSettings(pollerStatus());
  },
  { cap: "admin", body: githubSettingsSchema },
);
