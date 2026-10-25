import { z } from "zod";
import { api } from "@/server/http/api";
import { changePasscode } from "@/server/auth";
import { audit } from "@/server/audit";
import { clientKey } from "@/server/http/origin";

/** Strength rules are role-aware (assertPasscodeStrength: 6+, or a 4+ digit PIN for household), so the schema only bounds size. */
export const POST = api(
  ({ body, user, req, correlationId }) => {
    changePasscode(user.id, body.current, body.next, clientKey(req));
    audit({ actor: user.id, action: "auth.passcode_change", result: "ok", correlationId });
    return { ok: true, signedOut: true };
  },
  { body: z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) }) },
);
