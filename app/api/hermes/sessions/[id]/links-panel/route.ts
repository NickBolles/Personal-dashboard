import { z } from "zod";
import { api } from "@/server/http/api";
import { listPanelLinks, patchPanelLink, syncPanelLinks } from "@/server/chat/links";

export const dynamic = "force-dynamic";

/** Links side panel: URLs auto-collected from this conversation (pinned first). */
export const GET = api<undefined, { id: string }>(({ params, user }) => ({ links: listPanelLinks(user, params.id) }), { cap: "hermes.chat" });

const seen = z.object({
  links: z
    .array(
      z.object({
        url: z.string().url().max(2048),
        kind: z.enum(["artifact", "github", "web"]),
        domain: z.string().max(255),
        source: z.enum(["user", "assistant", "tool", "system"]),
        firstSeenAt: z.string().max(64).optional(),
      }),
    )
    .max(200),
});
/** Record links seen in the transcript (idempotent) and resolve titles; returns the panel. */
export const POST = api<z.infer<typeof seen>, { id: string }>(
  async ({ params, user, body }) => ({ links: await syncPanelLinks(user, params.id, body.links) }),
  { cap: "hermes.chat", body: seen },
);

const patch = z.object({ url: z.string().url().max(2048), pinned: z.boolean().optional(), removed: z.boolean().optional() });
export const PATCH = api<z.infer<typeof patch>, { id: string }>(
  ({ params, user, body }) => ({ links: patchPanelLink(user, params.id, body.url, { pinned: body.pinned, removed: body.removed }) }),
  { cap: "hermes.chat", body: patch },
);
