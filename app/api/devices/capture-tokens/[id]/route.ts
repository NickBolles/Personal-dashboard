import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { revokeCaptureToken } from "@/server/capture";

export const DELETE = api<undefined, { id: string }>(
  ({ user, params, correlationId }) => {
    if (user.via === "device") throw new HttpError(403, "browser_only", "Manage capture tokens from a signed-in browser");
    return revokeCaptureToken(user, params.id, correlationId);
  },
  { cap: "work.use" },
);
