import { api } from "@/server/http/api";
import type { z } from "zod";
import { githubAppManifestSchema } from "@/lib/github";
import { startManifest } from "@/server/work/github-app";

export const dynamic = "force-dynamic";

/**
 * Step 1 of "Create GitHub App" (admin, browser session only): the manifest
 * and a one-time state bound to this session. The browser POSTs `manifest`
 * to the returned GitHub URL itself; nothing secret is in either.
 */
export const POST = api<z.infer<typeof githubAppManifestSchema>>(({ req, user, body, correlationId }) => startManifest(user, req, body, correlationId), {
  cap: "admin",
  body: githubAppManifestSchema,
});
