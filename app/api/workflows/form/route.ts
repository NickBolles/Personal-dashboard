import { z } from "zod";
import { api } from "@/server/http/api";
import { startForm } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

const body = z
  .object({ command: z.string().min(2).max(300).optional(), workflowId: z.string().max(80).optional() })
  .strict()
  .refine((b) => b.command || b.workflowId, "command or workflowId");

/** Start form with smart defaults + palette prefill (D7: always shown, one tap Start). */
export const POST = api<z.infer<typeof body>>(({ user, body }) => startForm(user.id, body), { capAll: ["work.use", "hermes.chat"], body });
