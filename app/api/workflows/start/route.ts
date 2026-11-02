import { z } from "zod";
import { api } from "@/server/http/api";
import { prepareStart } from "@/server/workflows/start";

export const dynamic = "force-dynamic";

const body = z.object({ command: z.string().min(2).max(300) }).strict();

/**
 * Palette `/slug args`: resolve an active workflow and map the args to its start
 * fields. Returns what the client needs to start a filed chat (W1: no start form yet).
 */
export const POST = api<z.infer<typeof body>>(({ user, body }) => prepareStart(user.id, body.command), { capAll: ["work.use", "hermes.chat"], body });
