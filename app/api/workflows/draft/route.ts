import { z } from "zod";
import { api } from "@/server/http/api";
import { draftBody, draftWorkflow } from "@/server/workflows/draft";

export const dynamic = "force-dynamic";

/** AI draft (proposal only, nothing saved): from a chat ("Save chat as workflow") or a description. Finance chats are refused. */
export const POST = api<z.infer<typeof draftBody>>(({ user, body, correlationId }) => draftWorkflow(user, body, correlationId), {
  capAll: ["work.use", "work.ai"],
  body: draftBody,
});
