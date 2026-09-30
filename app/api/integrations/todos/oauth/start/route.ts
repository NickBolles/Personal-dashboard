import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import { randomToken } from "@/server/crypto";
import { setSetting } from "@/server/settings";
import { authorizationUrl, googleRedirectUri, requestOrigin } from "@/integrations/todos/google";

export const dynamic = "force-dynamic";

/** Begins Google consent for the Tasks scope. Client secret stays server-side. */
export const GET = api(({ req }) => {
  const state = randomToken(16);
  setSetting("google_oauth_state", { state, at: Date.now() });
  return NextResponse.redirect(authorizationUrl(googleRedirectUri(requestOrigin(req)), state));
});
