import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { pollTick } from "@/server/work/github-poller";

export const dynamic = "force-dynamic";

/** "Check now" (admin): one poller tick right away — linked PRs/issues and assigned issues. Read-only. */
export const POST = api(
  async ({ user, correlationId }) => {
    const result = await pollTick();
    audit({ actor: user.id, action: "github.poll_now", source: "github", result: "ok", correlationId, detail: result });
    return result;
  },
  { cap: "admin" },
);
