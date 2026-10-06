import QRCode from "qrcode";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { publicOrigin } from "@/server/http/origin";
import { audit } from "@/server/audit";
import { createPairingCode, pairingUri } from "@/server/devices";

/** Show a one-time pairing code (and QR) in Settings → Phones. Browser sessions only. */
export const POST = api(async ({ req, user, correlationId }) => {
  if (user.via === "device") throw new HttpError(403, "forbidden", "Pair new phones from Jarvis on the web");
  const origin = publicOrigin(req);
  const { code, expiresAt } = createPairingCode(user.id);
  const uri = pairingUri(origin, code);
  const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  audit({ actor: user.id, action: "device.pairing_code", result: "ok", correlationId });
  return { code, expiresAt, server: origin, uri, qrSvg };
});
