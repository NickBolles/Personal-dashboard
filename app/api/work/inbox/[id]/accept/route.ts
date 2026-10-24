import { api } from "@/server/http/api";
import type { z } from "zod";
import { inboxAcceptSchema } from "@/lib/work";
import { acceptEntry } from "@/server/work/inbox";

/** File an inbox entry as a new Work item (default: Miscellaneous), linking the GitHub issue. */
export const POST = api<z.infer<typeof inboxAcceptSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => acceptEntry(user, params.id, body, correlationId),
  {
    cap: "work.use",
    body: inboxAcceptSchema,
  },
);
