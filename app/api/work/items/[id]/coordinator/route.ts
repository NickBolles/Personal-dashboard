import { z } from "zod";
import { api } from "@/server/http/api";
import { coordinatorFor, lastRunAt, pinCoordinatorThread } from "@/server/work/coordinator";

/**
 * The area's coordinator chat: who answers, the coordinator conversation and a
 * prepared "Catch me up" prompt. Read-only; the prompt is only sent when the
 * owner taps Send (the runs route). Finance areas get no prompt.
 */
export const GET = api<undefined, { id: string }>(
  ({ user, params }) => {
    const info = coordinatorFor(user, params.id);
    return { ...info, lastRunAt: lastRunAt(user, info.sessionId) };
  },
  { cap: "work.use" },
);

const pin = z
  .object({
    sessionId: z
      .string()
      .regex(/^[\w.:-]{1,200}$/)
      .nullable(),
  })
  .strict();

/**
 * Pins the area's coordinator thread (the conversation the rail/tray talks in), or unpins it with null. The
 * conversation must be filed directly under the area. Returns the previous pin: Undo pins that again.
 */
export const PUT = api<z.infer<typeof pin>, { id: string }>(
  ({ user, params, body, correlationId }) => pinCoordinatorThread(user, params.id, body.sessionId, correlationId),
  { cap: "work.use", body: pin },
);
