import { api } from "@/server/http/api";
import { refreshLink } from "@/server/work/store";

/** Read-only GitHub readback (needs JARVIS_GITHUB_TOKEN). */
export const POST = api<undefined, { id: string }>(async ({ user, params, correlationId }) => ({ link: await refreshLink(user, params.id, correlationId) }), {
  cap: "work.use",
});
