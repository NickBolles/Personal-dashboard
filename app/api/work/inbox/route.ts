import { api } from "@/server/http/api";
import type { z } from "zod";
import { captureSchema } from "@/lib/work";
import { capture, getInbox } from "@/server/work/inbox";

export const dynamic = "force-dynamic";

/** Assigned GitHub issues, captures and (with hermes.chat) unfiled conversations. */
export const GET = api(({ user }) => getInbox(user), { cap: "work.use" });

/** Capture a quick note into the inbox. */
export const POST = api<z.infer<typeof captureSchema>>(({ user, body, correlationId }) => ({ entry: capture(user, body, correlationId) }), {
  cap: "work.use",
  body: captureSchema,
});
