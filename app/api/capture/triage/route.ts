import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { triageForItem } from "@/server/capture/triage-views";

export const dynamic = "force-dynamic";

const itemId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** The capture-triage outcome of the item a capture became (null when it wasn't handled by triage). */
export const GET = api(
  ({ req, user }) => {
    const id = itemId.safeParse(new URL(req.url).searchParams.get("item") ?? "");
    if (!id.success) throw new HttpError(400, "item", "item is required");
    return { triage: triageForItem(user.id, id.data) };
  },
  { cap: "work.use" },
);
