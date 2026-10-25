import { api } from "@/server/http/api";
import { resolveUser, SESSION_COOKIE } from "@/server/auth";
import { completeManifest } from "@/server/work/github-app";
import { startWorkGithubPoller } from "@/server/work/github-poller";

export const dynamic = "force-dynamic";

/**
 * Step 2 of "Create GitHub App": GitHub redirects the owner's browser here
 * with ?code&state. The state must belong to this admin's session; the code
 * is exchanged server-side and the credentials are stored encrypted. The
 * browser only ever gets a redirect back to Settings with an outcome code.
 */
export const GET = api(
  async ({ req, correlationId }) => {
    const user = resolveUser(req.headers, req.cookies.get(SESSION_COOKIE)?.value);
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const outcome = await completeManifest(user, req, code, state, correlationId);
    if (outcome === "created") startWorkGithubPoller();
    return new Response(null, {
      status: 303,
      headers: {
        location: `/settings/connections?github_app=${encodeURIComponent(outcome)}#github`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  },
  { public: true },
);
