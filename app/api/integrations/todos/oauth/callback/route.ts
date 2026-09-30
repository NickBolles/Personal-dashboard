import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import { getSetting, setSetting } from "@/server/settings";
import { safeEqual } from "@/server/crypto";
import { exchangeCode, googleRedirectUri, requestOrigin } from "@/integrations/todos/google";

export const dynamic = "force-dynamic";

export const GET = api(async ({ req }) => {
  const url = req.nextUrl;
  const origin = requestOrigin(req);
  const back = (status: string, message?: string) => {
    const to = new URL("/onboarding", origin);
    to.searchParams.set("step", "todos");
    to.searchParams.set("google", status);
    if (message) to.searchParams.set("message", message);
    return NextResponse.redirect(to);
  };
  const saved = getSetting<{ state: string; at: number }>("google_oauth_state");
  const state = url.searchParams.get("state") ?? "";
  if (!saved || !safeEqual(saved.state, state) || Date.now() - saved.at > 15 * 60_000) return back("error", "The sign-in link expired. Try again.");
  setSetting("google_oauth_state", null);
  const error = url.searchParams.get("error");
  if (error) return back("error", error);
  const code = url.searchParams.get("code");
  if (!code) return back("error", "Google did not return a code");
  try {
    await exchangeCode(code, googleRedirectUri(origin));
    return back("connected");
  } catch (err) {
    return back("error", (err as Error).message);
  }
});
