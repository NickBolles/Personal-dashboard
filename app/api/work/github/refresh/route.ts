import { api } from "@/server/http/api";
import { githubRefreshSchema } from "@/lib/work";
import { autoRefreshLinks } from "@/server/work/store";

/**
 * Throttled, read-only GitHub refresh of your linked PRs/issues (one item, or
 * all of yours for the dashboard). A no-op without JARVIS_GITHUB_TOKEN.
 */
export const POST = api(({ user, body, correlationId }) => autoRefreshLinks(user, { itemId: body.itemId }, correlationId), {
  cap: "work.use",
  body: githubRefreshSchema,
});
