import { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { getSmartSettings, saveSmartSettings } from "@/server/smart/store";

export const dynamic = "force-dynamic";

/** Smart replies (jarvis-ui@1) for this person: off by default (Settings → Smart replies). */
export const GET = api(({ user }) => getSmartSettings(user.id));

const body = z.object({ enabled: z.boolean().optional(), calendarWrites: z.boolean().optional() }).strict();

export const PUT = api<z.infer<typeof body>>(
  ({ user, body, correlationId }) => {
    const next = saveSmartSettings(user.id, body);
    audit({
      actor: user.id,
      action: "smart.settings",
      source: "smart",
      result: "ok",
      correlationId,
      detail: { enabled: next.enabled, calendarWrites: next.calendarWrites },
    });
    return next;
  },
  { body, cap: "hermes.chat" },
);
