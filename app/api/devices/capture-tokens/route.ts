import { api } from "@/server/http/api";
import type { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { captureTokenCreateSchema } from "@/lib/ai";
import { createCaptureToken, listCaptureTokens } from "@/server/capture";

export const dynamic = "force-dynamic";

const browserOnly = (via: string) => {
  if (via === "device") throw new HttpError(403, "browser_only", "Manage capture tokens from a signed-in browser");
};

/** Capture tokens (jcap_…) for HTTP Shortcuts/Tasker: capture-only scope, revocable, rate-limited. */
export const GET = api(
  ({ user }) => {
    browserOnly(user.via);
    return { tokens: listCaptureTokens(user.id) };
  },
  { cap: "work.use" },
);

/** The token value is returned exactly once and never stored or audited in clear. */
export const POST = api<z.infer<typeof captureTokenCreateSchema>>(
  ({ user, body, correlationId }) => {
    browserOnly(user.via);
    return createCaptureToken(user, body, correlationId);
  },
  { cap: "work.use", body: captureTokenCreateSchema },
);
