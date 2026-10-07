import { z } from "zod";
import { api } from "@/server/http/api";
import { clientKey } from "@/server/http/origin";
import { checkThrottle, getUser, recordFailure } from "@/server/auth";
import { audit } from "@/server/audit";
import { redeemPairingCode } from "@/server/devices";
import { HttpError } from "@/server/http/errors";

const schema = z.object({
  code: z.string().min(4).max(20),
  name: z.string().min(1).max(80),
  platform: z.enum(["android"]).default("android"),
  appVersion: z.string().max(40).optional(),
});

/** Public: exchange a pairing code for a device token. Throttled like passcode login. */
export const POST = api<z.infer<typeof schema>>(
  ({ req, body, correlationId }) => {
    const key = `pair:${clientKey(req)}`;
    checkThrottle(key);
    try {
      const r = redeemPairingCode(body.code, body);
      audit({ actor: r.userId, action: "device.paired", sourceRecord: r.deviceId, result: "ok", correlationId, detail: { name: body.name } });
      return { token: r.token, deviceId: r.deviceId, user: { name: getUser(r.userId)?.name ?? "" } };
    } catch (err) {
      if (err instanceof HttpError) recordFailure(key);
      throw err;
    }
  },
  // No cookies are read or set here, so there's nothing for CSRF to protect.
  { public: true, csrf: false, body: schema },
);
