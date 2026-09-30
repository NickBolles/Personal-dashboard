import { z } from "zod";
import { api } from "@/server/http/api";
import { changePasscode } from "@/server/auth";
import { audit } from "@/server/audit";

export const POST = api(
  ({ body, user, correlationId }) => {
    changePasscode(user.id, body.current, body.next);
    audit({ actor: user.id, action: "auth.passcode_change", result: "ok", correlationId });
    return { ok: true, signedOut: true };
  },
  { body: z.object({ current: z.string().min(1), next: z.string().min(6).max(200) }) },
);
