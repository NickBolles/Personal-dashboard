import { z } from "zod";
import { api } from "@/server/http/api";
import { setPrimaryChat } from "@/server/work/primary-chat";
import type { OpOut } from "@/server/work/store";

const schema = z.object({ sessionId: z.string().min(1).max(200) }).strict();

/** "Make primary": one of the task's other chats becomes its primary chat. Undoable (the op is returned). */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const out: OpOut = {};
    return { item: setPrimaryChat(user, params.id, body.sessionId, correlationId, out), op: out.op ?? null };
  },
  { capAll: ["work.use", "hermes.chat"], body: schema },
);
