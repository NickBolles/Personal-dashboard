import { api } from "@/server/http/api";
import { refreshInstallations } from "@/server/work/github-app";
import { startWorkGithubPoller } from "@/server/work/github-poller";

export const dynamic = "force-dynamic";

/** Re-read the App's installations and their repositories with the App JWT (admin). Read-only. */
export const POST = api(
  async ({ user, correlationId }) => {
    const app = await refreshInstallations(user.id, correlationId);
    startWorkGithubPoller();
    return { app };
  },
  { cap: "admin" },
);
