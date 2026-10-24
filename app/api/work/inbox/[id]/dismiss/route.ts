import { api } from "@/server/http/api";
import { dismissEntry } from "@/server/work/inbox";

/** Hide an inbox entry for good (remembered; the issue isn't touched on GitHub). */
export const POST = api<undefined, { id: string }>(({ user, params, correlationId }) => dismissEntry(user, params.id, correlationId), { cap: "work.use" });
