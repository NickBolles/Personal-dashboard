import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { getIntegrationDef, type IntegrationKind } from "@/integrations/registry";
import { publicIntegration, saveIntegration } from "@/integrations/store";

function kindOf(kind: string): IntegrationKind {
  if (!getIntegrationDef(kind)) throw new HttpError(404, "unknown_integration", "Unknown integration");
  return kind as IntegrationKind;
}

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean()])).optional(),
  secrets: z.record(z.string(), z.string().max(4000).nullable()).optional(),
});

export const GET = api<undefined, { kind: string }>(({ params }) => publicIntegration(kindOf(params.kind)));

export const PUT = api<z.infer<typeof updateSchema>, { kind: string }>(
  ({ params, body, user, correlationId }) => {
    const kind = kindOf(params.kind);
    const res = saveIntegration(kind, body);
    audit({
      actor: user.id,
      action: "integration.update",
      source: kind,
      result: "ok",
      correlationId,
      detail: { enabled: body.enabled, fields: Object.keys(body.config ?? {}), secretsChanged: Object.keys(body.secrets ?? {}) },
    });
    return res;
  },
  { body: updateSchema },
);
