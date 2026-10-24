import { api } from "@/server/http/api";
import { testGithubConnection } from "@/server/work/github-connections";

export const dynamic = "force-dynamic";

/** Read-only readback with the stored token (GET /user, repos or org, rate limit). */
export const POST = api<undefined, { id: string }>(({ user, params, correlationId }) => testGithubConnection(user, params.id, correlationId), { cap: "admin" });
