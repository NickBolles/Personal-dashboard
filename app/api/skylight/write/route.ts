import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { assertSkylightWritable, runSkylightWrite } from "@/integrations/skylight/write";
import { doneLabel, skylightWriteOp, type SkylightWriteResult } from "@/lib/skylight-write";
import { recordWrite, skylightWriteTarget } from "@/server/skylight-writes";
import { refreshSource } from "@/server/sources";

export const POST = api(
  async ({ body, user, correlationId }): Promise<SkylightWriteResult> => {
    let target = skylightWriteTarget(body);
    try {
      assertSkylightWritable();
      const result = await runSkylightWrite(body, user, { correlationId });
      target = skylightWriteTarget(body, result.created);
      const row = recordWrite(body, user, result.created);
      audit({ actor: user.id, action: "skylight.write", source: "skylight", sourceRecord: target, result: "ok", correlationId });
      await refreshSource("skylight").catch(() => undefined);
      return { ok: true, message: doneLabel(body), writeId: row.id, undoable: row.inverse != null };
    } catch (err) {
      // Keep why it failed (op + error code + Skylight's own short reason) so a failed write can be diagnosed later.
      const e = err as { code?: unknown; detail?: unknown };
      const detail: Record<string, unknown> = { op: body.op, ...(typeof e.code === "string" ? { code: e.code } : {}) };
      if (e.detail && typeof e.detail === "object") Object.assign(detail, e.detail);
      audit({ actor: user.id, action: "skylight.write", source: "skylight", sourceRecord: target, result: "error", correlationId, detail });
      throw err;
    }
  },
  { cap: "skylight.write", body: skylightWriteOp },
);
