import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { addComment, listComments } from "@/server/finance/plan";

const TYPES = ["event", "revision", "checkin", "action"] as const;

export const GET = api(
  ({ req }) => {
    const type = req.nextUrl.searchParams.get("type") ?? "";
    const id = req.nextUrl.searchParams.get("id") ?? "";
    if (!(TYPES as readonly string[]).includes(type) || !id) throw new HttpError(400, "bad_target", "type and id are required");
    return { comments: listComments(type, id) };
  },
  { cap: "finance.view" },
);

const schema = z.object({ type: z.enum(TYPES), id: z.string().min(1).max(80), body: z.string().trim().min(1).max(2000) });
export const POST = api<z.infer<typeof schema>>(
  ({ body, user, correlationId }) => ({ id: addComment(body.type, body.id, body.body, user.id, correlationId) }),
  {
    cap: "finance.view",
    body: schema,
  },
);
