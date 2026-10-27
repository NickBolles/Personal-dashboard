import { api } from "@/server/http/api";
import { createPathSchema } from "@/lib/work";
import { createPath } from "@/server/work/store";

/** Quick add with a path ("Area / Project / item"): reuses existing levels by title, creates the rest. */
export const POST = api(({ user, body, correlationId }) => createPath(user, body, correlationId), { cap: "work.use", body: createPathSchema });
