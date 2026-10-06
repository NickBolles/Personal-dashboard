import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { getAdapter } from "@/integrations";
import { refreshSource, setActionPref } from "@/server/sources";
import { DAY } from "@/lib/time";
import { requireCap } from "@/server/access";
import { actionCapability } from "@/lib/modules";

const bodySchema = z.object({
  actionId: z.string().min(3).max(500),
  kind: z.enum(["complete", "snooze", "acknowledge", "pin", "unpin"]),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Execute a supported action. Upstream mutations report success only after the
 * adapter confirms via readback. acknowledge/pin are Jarvis-local preferences.
 */
export const POST = api<z.infer<typeof bodySchema>>(
  async ({ body, user, correlationId }) => {
    const idx = body.actionId.indexOf(":");
    const source = body.actionId.slice(0, idx);
    const sourceId = body.actionId.slice(idx + 1);
    requireCap(user, actionCapability(source, body.kind));
    if (body.kind === "pin" || body.kind === "unpin") {
      setActionPref(user.id, body.actionId, { pinned: body.kind === "pin" });
      return { ok: true, message: body.kind === "pin" ? "Pinned" : "Unpinned" };
    }
    if (body.kind === "acknowledge") {
      setActionPref(user.id, body.actionId, { hiddenUntil: new Date(Date.now() + 7 * DAY).toISOString() });
      audit({ actor: user.id, action: "action.acknowledge", source, sourceRecord: sourceId, result: "ok", correlationId });
      return { ok: true, message: "Acknowledged" };
    }
    const adapter = getAdapter(source);
    if (!adapter?.act) throw new HttpError(400, "unsupported", "This source does not support that action");
    const result = await adapter.act(sourceId, body.kind, { until: body.until, actor: user.id, correlationId });
    await refreshSource(adapter.source).catch(() => undefined);
    return result;
  },
  { body: bodySchema },
);
