import { z } from "zod";
import { api } from "@/server/http/api";
import { markAllRead, markRead } from "@/server/chat/reads";

const body = z.union([
  z
    .object({
      sessionId: z.string().trim().min(1).max(200),
      messageCount: z.number().int().min(0).max(1_000_000).nullish(),
      lastMessageId: z.string().max(200).nullish(),
    })
    .strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

/** C4: mark one conversation read (on open), or all of them ("Mark all read"). Your own markers only. */
export const POST = api(
  ({ user, body: b }) => ("all" in b ? markAllRead(user.id) : markRead(user.id, b.sessionId, { messageCount: b.messageCount, lastMessageId: b.lastMessageId })),
  { cap: "hermes.chat", body },
);
