import { api } from "@/server/http/api";
import { briefAssistSchema, type BriefAssistInput } from "@/lib/brief";
import { startAssist } from "@/server/brief/assist";
import { IMPROVE_CAPS } from "@/server/brief/improve";

export const dynamic = "force-dynamic";

/**
 * The sparkle on a row of the brief: file that one task and start the area's
 * agent researching it (docs/brief.md). Undo is DELETE /api/brief/improve/:id.
 */
export const POST = api<BriefAssistInput>(
  async ({ user, body, correlationId }) => Response.json(await startAssist(user, body, correlationId), { status: 201 }),
  { body: briefAssistSchema, capAll: [...IMPROVE_CAPS] },
);
