import type { NextRequest } from "next/server";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { bearerToken, resolveUser, SESSION_COOKIE } from "@/server/auth";
import { CAPTURE_TOKEN_PREFIX, captureStatus, captureTokenFromBearer } from "@/server/capture";

export const dynamic = "force-dynamic";

/** Status of one capture. A capture token may read only the captures it made. */
export const GET = api<undefined, { id: string }>(
  ({ req, params }) => {
    const bearer = bearerToken((req as NextRequest).headers);
    if (bearer?.startsWith(CAPTURE_TOKEN_PREFIX)) {
      const t = captureTokenFromBearer(bearer);
      if (!t) throw new HttpError(401, "unauthenticated", "Invalid or revoked capture token");
      return captureStatus(t.userId, params.id, t.id);
    }
    const user = resolveUser(req.headers, req.cookies.get(SESSION_COOKIE)?.value);
    if (!user) throw new HttpError(401, "unauthenticated", "Sign in required");
    if (!user.capabilities.has("work.use")) throw new HttpError(403, "forbidden", "You don't have access to that.");
    return captureStatus(user.id, params.id);
  },
  { public: true },
);
