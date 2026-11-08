import "server-only";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { controlRules, entityServices, serviceLabel } from "@/integrations/home-assistant/controls";
import { cleanServiceData, serviceRisk, servicePolicy, type ServiceData } from "@/lib/ha-policy";

export type DeviceProposal = { entityId: string; service: string; data?: Record<string, unknown>; reason: string };

/** House deep link that opens the confirm card for a proposed change (the owner still confirms). */
export function proposalHref(entityId: string, service: string, data?: ServiceData) {
  const q = new URLSearchParams({ entity: entityId, propose: service });
  if (data && Object.keys(data).length) q.set("data", JSON.stringify(data));
  return `/home-control?${q.toString()}`;
}

/**
 * Agents never operate devices. A proposal is validated against the policy
 * matrix and the allowlist (no Home Assistant call is made) and turned into
 * the text of a Needs-you decision; the owner confirms it on the House page.
 */
export function buildDeviceProposal(p: DeviceProposal, profile: string, actor: string, correlationId: string) {
  const base = { actor, action: `ha.propose.${p.service}`, source: "home_assistant", sourceRecord: p.entityId, correlationId };
  if (!servicePolicy(p.entityId, p.service) || !entityServices(controlRules(), p.entityId).includes(p.service)) {
    audit({ ...base, result: "rejected", detail: { reason: "not_allowlisted", via: `agent:${profile}` } });
    throw new HttpError(403, "not_allowlisted", "That device action isn't allowed in Jarvis");
  }
  let data: ServiceData;
  try {
    data = cleanServiceData(p.entityId, p.service, p.data);
  } catch (e) {
    throw new HttpError(400, "bad_data", (e as Error).message.replace(/^bad_data: /, ""));
  }
  const risk = serviceRisk(p.entityId, p.service);
  const label = serviceLabel(p.entityId, p.service);
  const href = proposalHref(p.entityId, p.service, data);
  const detail = Object.keys(data).length
    ? ` (${Object.entries(data)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")})`
    : "";
  const question =
    `@${profile} proposes a device change${risk === "high" ? " (HIGH-RISK)" : ""}: ${label} ${p.entityId}${detail}. Why: ${p.reason}. Confirm it on House.`.slice(
      0,
      500,
    );
  audit({ ...base, result: "ok", detail: { risk, via: `agent:${profile}`, proposed: true } });
  return { question, choices: ["I'll confirm on House", "Decline"], risk, href };
}
