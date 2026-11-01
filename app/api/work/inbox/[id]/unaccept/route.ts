import { api } from "@/server/http/api";
import { unacceptEntry } from "@/server/work/inbox";

/** Undo a recent accept (bulk "Accept N suggestions" → Undo): the entry returns to the Inbox, its thread is archived. */
export const POST = api<undefined, { id: string }>(({ user, params, correlationId }) => unacceptEntry(user, params.id, correlationId), { cap: "work.use" });
