import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { ensureRunSeqs, listRunEvents, resolveRun } from "@/server/work/run-events";
import { listItems } from "@/server/work/store";

export const GET = api<undefined, { ref: string }>(
  ({ user, params, req }) => {
    ensureRunSeqs(user.id);
    const run = resolveRun(user.id, params.ref);
    if (!listItems(user.id).some((i) => i.id === run.itemId && !i.archived)) throw new HttpError(404, "not_found", "No run with that reference");
    const raw = req.nextUrl.searchParams.get("limit");
    const limit =
      raw === null
        ? 100
        : z
            .string()
            .regex(/^[1-9]\d{0,2}$/)
            .transform(Number)
            .pipe(z.number().int().max(200))
            .parse(raw);
    return { events: listRunEvents(user.id, { runIds: [run.id], limit }) };
  },
  { cap: "work.use" },
);
