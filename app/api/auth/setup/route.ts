import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "@/server/http/api";
import {
  AuthError,
  checkThrottle,
  claimInstance,
  clearFailures,
  createSession,
  recordFailure,
  SESSION_COOKIE,
  sessionCookieOptions,
  isClaimed,
  throttleKeys,
} from "@/server/auth";
import { clientKey } from "@/server/http/origin";
import { config } from "@/server/config";
import { updatePreferences } from "@/server/settings";

export const GET = api(() => ({ claimed: isClaimed(), authMode: config.authMode }), { public: true });

export const POST = api(
  ({ body, req }) => {
    const keys = throttleKeys("setup", clientKey(req));
    checkThrottle(keys);
    let userId: string;
    try {
      userId = claimInstance(body);
    } catch (err) {
      if (err instanceof AuthError && err.code === "bad_setup_code") recordFailure(keys);
      throw err;
    }
    clearFailures(keys);
    updatePreferences({ displayName: body.name.trim() || "Owner", ...(body.timezone ? { timezone: body.timezone } : {}) });
    const s = createSession(userId, req.headers.get("user-agent"));
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, s.token, sessionCookieOptions(s.expiresAt));
    return res;
  },
  {
    public: true,
    body: z.object({
      setupCode: z.string().min(1).max(64),
      name: z.string().max(60).default("Owner"),
      passcode: z.string().min(6).max(200),
      timezone: z.string().max(64).optional(),
    }),
  },
);
