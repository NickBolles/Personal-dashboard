import { api } from "@/server/http/api";
import type { z } from "zod";
import { linkStateSchema } from "@/lib/work";
import { removeLink, setLinkState } from "@/server/work/store";

type P = { id: string };
/** Manual "Mark merged / closed": a merged implementation PR runs the merge rules. */
export const PATCH = api<z.infer<typeof linkStateSchema>, P>(
  ({ user, params, body, correlationId }) => ({ link: setLinkState(user, params.id, body.externalState, correlationId) }),
  {
    cap: "work.use",
    body: linkStateSchema,
  },
);
export const DELETE = api<undefined, P>(({ user, params, correlationId }) => removeLink(user, params.id, correlationId), { cap: "work.use" });
