import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { cameraSnapshot } from "@/integrations/home-assistant/devices";

export const dynamic = "force-dynamic";

/** A current camera still (never cached, here or in the service worker). */
export const GET = api<undefined, { entityId: string }>(
  async ({ params, req, user, correlationId }) => {
    const res = await cameraSnapshot(params.entityId, req.signal);
    audit({ actor: user.id, action: "ha.camera.view", source: "home_assistant", sourceRecord: params.entityId, result: "ok", correlationId });
    return res;
  },
  { cap: "home_assistant.cameras" },
);
