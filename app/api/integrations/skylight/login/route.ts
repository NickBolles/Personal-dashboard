import { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { skylightSignIn } from "@/integrations/skylight/adapter";

/** One-time sign-in. Email/password are used for this request only and never stored. */
export const POST = api(
  async ({ body, user, correlationId }) => {
    try {
      await skylightSignIn(body.email, body.password);
      audit({ actor: user.id, action: "skylight.sign_in", source: "skylight", result: "ok", correlationId });
      return { ok: true };
    } catch (err) {
      audit({ actor: user.id, action: "skylight.sign_in", source: "skylight", result: "error", correlationId, detail: { error: (err as Error).message } });
      throw err;
    }
  },
  { body: z.object({ email: z.string().email(), password: z.string().min(1).max(200) }) },
);
