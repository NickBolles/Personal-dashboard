import { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { deletePerson, listPeople, updatePerson } from "@/server/people";
import { ALL_CAPABILITIES, ROLES } from "@/lib/modules";

const schema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  username: z.string().trim().min(2).max(32).optional(),
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
  passcode: z.string().min(4).max(200).optional(),
  capabilities: z.record(z.enum(ALL_CAPABILITIES as [string, ...string[]]), z.boolean()).optional(),
});

export const PATCH = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    const b = listPeople().find((p) => p.id === params.id);
    const before = b && { name: b.name, username: b.username, role: b.role, disabled: b.disabled, overrides: b.overrides };
    const person = updatePerson(params.id, body, user.id);
    audit({
      actor: user.id,
      action: "people.update",
      sourceRecord: params.id,
      result: "ok",
      correlationId,
      detail: { before, after: { ...body, passcode: body.passcode ? "[changed]" : undefined } },
    });
    return { person };
  },
  { cap: "admin", body: schema },
);

export const DELETE = api<undefined, { id: string }>(
  ({ params, user, correlationId }) => {
    deletePerson(params.id, user.id);
    audit({ actor: user.id, action: "people.remove", sourceRecord: params.id, result: "ok", correlationId });
    return { ok: true };
  },
  { cap: "admin" },
);
