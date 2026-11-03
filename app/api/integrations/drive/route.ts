import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { disconnectDrive, driveStatus } from "@/server/drive/google-drive";

export const dynamic = "force-dynamic";

/** #141: Drive connection status (flag, OAuth client present, connected). Never returns tokens. */
export const GET = api(() => driveStatus(), { cap: "admin" });

/** Disconnect: forget the refresh token and revoke it at Google (best effort). */
export const DELETE = api(
  async ({ user, correlationId }) => {
    const r = await disconnectDrive();
    audit({ actor: user.id, action: "integration.drive.disconnect", result: "ok", correlationId, detail: r });
    return { ...driveStatus(), ...r };
  },
  { cap: "admin" },
);
