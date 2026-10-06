import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { revokeDevice } from "@/server/devices";

/** Revoke a paired phone (also how the app signs itself out: DELETE its own id). */
export const DELETE = api<undefined, { id: string }>(({ params, user, correlationId }) => {
  if (!revokeDevice(user.id, params.id)) throw new HttpError(404, "not_found", "Device not found");
  audit({ actor: user.id, action: "device.revoked", sourceRecord: params.id, result: "ok", correlationId });
  return { ok: true };
});
