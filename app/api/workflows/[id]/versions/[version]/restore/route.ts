import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { restoreVersion } from "@/server/workflows/store";

export const dynamic = "force-dynamic";

/** Restore an old version by saving it as a new immutable version. */
export const POST = api<undefined, { id: string; version: string }>(
  ({ user, params, correlationId }) => {
    const v = Number(params.version);
    if (!Number.isInteger(v) || v < 1) throw new HttpError(400, "bad_version", "Version must be a positive number");
    return restoreVersion({ userId: user.id, correlationId }, params.id, v);
  },
  { cap: "work.use" },
);
