import { z } from "zod";
import { api } from "@/server/http/api";
import { getSessionDetail, updateSession } from "@/server/assistant";
import { linksForSession } from "@/integrations/paperclip/service";
import { can } from "@/server/access";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(
  async ({ params, user }) => ({
    ...(await getSessionDetail(user, params.id)),
    links: can(user, "paperclip.view") ? linksForSession(params.id) : [],
  }),
  { cap: "hermes.chat" },
);

const patch = z.object({
  title: z.string().max(200).nullable().optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  shared: z.boolean().optional(),
});
export const PATCH = api<z.infer<typeof patch>, { id: string }>(
  ({ params, body, user, correlationId }) => updateSession(user, params.id, body, correlationId),
  { body: patch, cap: "hermes.chat" },
);
