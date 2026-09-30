import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { hermesConn, HermesAutomationClient } from "@/integrations/hermes/client";

export const POST = api<undefined, { id: string; op: string }>(async ({ params, user, correlationId }) => {
  if (!/^[a-f0-9]{12}$/.test(params.id)) throw new HttpError(400, "bad_job_id", "Invalid job id");
  const op = params.op as "pause" | "resume" | "run";
  if (!["pause", "resume", "run"].includes(op)) throw new HttpError(404, "unknown_op", "Unknown operation");
  const res = await HermesAutomationClient[op](hermesConn(), params.id);
  audit({ actor: user.id, action: `hermes.job.${op}`, source: "hermes", sourceRecord: params.id, result: "ok", correlationId });
  return res;
});
