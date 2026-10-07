import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { fcmStatus, saveFcmConfig } from "@/server/notifications/fcm";

export const GET = api(() => fcmStatus());

const schema = z.object({
  googleServices: z.string().max(20_000).nullable().optional(),
  serviceAccount: z.string().max(20_000).nullable().optional(),
});

/** Paste google-services.json and a service-account key (Settings → Phones). Validated before saving. */
export const PUT = api<z.infer<typeof schema>>(
  ({ body, user, correlationId }) => {
    if (user.via === "device") throw new HttpError(403, "forbidden", "Change push settings from Jarvis on the web");
    try {
      saveFcmConfig(body);
    } catch (err) {
      throw new HttpError(400, "bad_firebase_config", `That doesn't look like the right file: ${(err as Error).message.slice(0, 200)}`);
    }
    audit({ actor: user.id, action: "settings.fcm", result: "ok", correlationId });
    return fcmStatus();
  },
  { cap: "admin", body: schema },
);
