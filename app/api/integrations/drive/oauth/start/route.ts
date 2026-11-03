import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import { randomToken } from "@/server/crypto";
import { requestOrigin } from "@/integrations/todos/google";
import { beginDriveConsent, driveAuthorizationUrl, driveRedirectUri } from "@/server/drive/google-drive";

export const dynamic = "force-dynamic";

/** #141: separate "Connect Drive" consent (drive.file only). Never part of sign-in. */
export const GET = api(
  ({ req }) => {
    const state = randomToken(16);
    const url = driveAuthorizationUrl(driveRedirectUri(requestOrigin(req)), state);
    beginDriveConsent(state);
    return NextResponse.redirect(url);
  },
  { cap: "admin" },
);
