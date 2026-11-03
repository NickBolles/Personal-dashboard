import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { safeEqual } from "@/server/crypto";
import { requestOrigin } from "@/integrations/todos/google";
import { driveRedirectUri, exchangeDriveCode, takeDriveConsentState } from "@/server/drive/google-drive";

export const dynamic = "force-dynamic";

export const GET = api(
  async ({ req, user, correlationId }) => {
    const url = req.nextUrl;
    const origin = requestOrigin(req);
    const back = (status: string, message?: string) => {
      const to = new URL("/settings/connections", origin);
      to.searchParams.set("drive", status);
      if (message) to.searchParams.set("message", message.slice(0, 200));
      to.hash = "drive";
      return NextResponse.redirect(to);
    };
    const saved = takeDriveConsentState();
    const state = url.searchParams.get("state") ?? "";
    if (!saved || !safeEqual(saved.state, state) || Date.now() - saved.at > 15 * 60_000) return back("error", "The Drive link expired. Try again.");
    const error = url.searchParams.get("error");
    if (error) return back("error", error);
    const code = url.searchParams.get("code");
    if (!code) return back("error", "Google did not return a code");
    try {
      await exchangeDriveCode(code, driveRedirectUri(origin));
      audit({ actor: user.id, action: "integration.drive.connect", result: "ok", correlationId, detail: { scope: "drive.file" } });
      return back("connected");
    } catch (err) {
      audit({ actor: user.id, action: "integration.drive.connect", result: "error", correlationId });
      return back("error", (err as Error).message);
    }
  },
  { cap: "admin" },
);
