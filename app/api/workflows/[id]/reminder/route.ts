import { z } from "zod";
import { api } from "@/server/http/api";
import { getReminder, reminderBody, setReminder } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(({ user, params }) => getReminder(user.id, params.id), { cap: "work.use" });

/** Opt-in reminder (D6): a notification linking to the start form. Never starts a model run. */
export const PUT = api<z.infer<typeof reminderBody>, { id: string }>(
  ({ user, params, body, correlationId }) => setReminder({ userId: user.id, correlationId }, params.id, body),
  { cap: "work.use", body: reminderBody },
);
