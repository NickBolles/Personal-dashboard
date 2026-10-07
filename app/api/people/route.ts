import { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { createPerson, listPeople } from "@/server/people";
import { ROLES } from "@/lib/modules";

export const dynamic = "force-dynamic";

export const GET = api(() => ({ people: listPeople() }), { cap: "admin" });

const schema = z.object({
  name: z.string().trim().min(1).max(60),
  username: z.string().trim().min(2).max(32),
  role: z.enum(ROLES),
  /** set a PIN/passcode now (e.g. the kitchen tablet) instead of sending an invite */
  passcode: z.string().min(4).max(200).optional(),
});

/** Add someone. Returns a one-time invite code unless a passcode was set. */
export const POST = api<z.infer<typeof schema>>(
  ({ body, user, correlationId }) => {
    const { id, invite } = createPerson(body, user.id);
    audit({ actor: user.id, action: "people.add", sourceRecord: id, result: "ok", correlationId, detail: { role: body.role, username: body.username } });
    return { person: listPeople().find((p) => p.id === id), invite };
  },
  { cap: "admin", body: schema },
);
