import { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { assistantStatus, saveAssistantSettings } from "@/server/assistant/settings";
import { ASSISTANT_BACKENDS, CLAUDE_MODELS, EFFORTS } from "@/lib/assistant";

export const dynamic = "force-dynamic";

/** Which backends are available and the default (everyone who chats sees this; the key never leaves the server). */
export const GET = api(() => assistantStatus(), { cap: "hermes.chat" });

const schema = z.object({
  defaultBackend: z.enum(ASSISTANT_BACKENDS).optional(),
  model: z.enum(CLAUDE_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
  effort: z.enum(EFFORTS).optional(),
  apiKey: z.string().max(400).nullable().optional(),
});

export const PUT = api<z.infer<typeof schema>>(
  ({ body, user, correlationId }) => {
    const status = saveAssistantSettings(body);
    audit({
      actor: user.id,
      action: "settings.assistant",
      result: "ok",
      correlationId,
      detail: { ...body, apiKey: body.apiKey === undefined ? undefined : body.apiKey ? "[changed]" : "[cleared]" },
    });
    return status;
  },
  { cap: "admin", body: schema },
);
