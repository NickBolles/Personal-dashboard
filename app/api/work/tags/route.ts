import { z } from "zod";
import { api } from "@/server/http/api";
import { TAG_COLORS } from "@/lib/item-tags";
import { assigneeDirectory, listTags, renameTag, setTagColor } from "@/server/work/tags";

/** Tags with colours and item counts, plus who items can be assigned to (agents + people). */
export const GET = api(({ user }) => ({ tags: listTags(user.id), assignees: assigneeDirectory() }), { cap: "work.use" });

const patchSchema = z
  .object({
    name: z.string().min(1).max(64),
    /** rename (or merge into an existing tag) */
    to: z.string().min(1).max(64).optional(),
    color: z.enum(TAG_COLORS).optional(),
  })
  .strict();

/** Settings → Tags: recolour, rename, or merge (rename onto an existing name). */
export const PATCH = api<z.infer<typeof patchSchema>>(
  ({ user, body }) => {
    const result = body.to ? renameTag(user.id, body.name, body.to) : { touched: 0, merged: false };
    if (body.color) setTagColor(user.id, body.to ?? body.name, body.color);
    return { ...result, tags: listTags(user.id) };
  },
  { cap: "work.use", body: patchSchema },
);
