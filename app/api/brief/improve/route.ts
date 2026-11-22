import { api } from "@/server/http/api";
import { briefImproveSchema, type BriefImproveInput } from "@/lib/brief";
import { IMPROVE_CAPS, startImprovement } from "@/server/brief/improve";

export const dynamic = "force-dynamic";

/**
 * "Improve" on the brief: files the request as an item, opens a Hermes
 * conversation with that area's agent under it and sends the request as the
 * first message. Needs the brief, chat and work capabilities together.
 */
export const POST = api<BriefImproveInput>(
  async ({ user, body, correlationId }) => Response.json(await startImprovement(user, body, correlationId), { status: 201 }),
  { body: briefImproveSchema, capAll: [...IMPROVE_CAPS] },
);
