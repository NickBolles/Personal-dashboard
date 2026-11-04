import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { undoWrite } from "@/server/skylight-writes";
import { refreshSource } from "@/server/sources";

export const POST = api(
  async ({ params, user, correlationId }) => {
    let target = params.id;
    try {
      const row = await undoWrite(params.id, user, { correlationId });
      target = row.target;
      audit({ actor: user.id, action: "skylight.undo", source: "skylight", sourceRecord: target, result: "ok", correlationId });
      await refreshSource("skylight").catch(() => undefined);
      return { ok: true, message: "Undone" };
    } catch (err) {
      audit({ actor: user.id, action: "skylight.undo", source: "skylight", sourceRecord: target, result: "error", correlationId });
      throw err;
    }
  },
  { cap: "skylight.write" },
);
