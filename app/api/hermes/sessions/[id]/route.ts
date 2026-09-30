import { z } from "zod";
import { api } from "@/server/http/api";
import { getSessionDetail, updateSession } from "@/integrations/hermes/service";
import { linksForSession } from "@/integrations/paperclip/service";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(async ({ params }) => ({
  ...(await getSessionDetail(params.id)),
  links: linksForSession(params.id),
}));

const patch = z.object({ title: z.string().max(200).nullable().optional(), archived: z.boolean().optional(), pinned: z.boolean().optional() });
export const PATCH = api<z.infer<typeof patch>, { id: string }>(
  ({ params, body, user, correlationId }) => updateSession(user, params.id, body, correlationId),
  { body: patch },
);
