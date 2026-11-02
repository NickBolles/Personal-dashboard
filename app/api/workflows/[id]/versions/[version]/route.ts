import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { getVersion } from "@/server/workflows/store";

export const dynamic = "force-dynamic";

/** One immutable version + its diff against the previous version. */
export const GET = api<undefined, { id: string; version: string }>(
  ({ user, params }) => {
    const v = Number(params.version);
    if (!Number.isInteger(v) || v < 1) throw new HttpError(400, "bad_version", "Version must be a positive number");
    return getVersion(user.id, params.id, v);
  },
  { cap: "work.use" },
);
