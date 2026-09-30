import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "@/server/http/api";
import { claimInstance, createSession, SESSION_COOKIE, sessionCookieOptions, isClaimed } from "@/server/auth";
import { config } from "@/server/config";
import { updatePreferences } from "@/server/settings";

export const GET = api(() => ({ claimed: isClaimed(), authMode: config.authMode }), { public: true });

export const POST = api(
  ({ body, req }) => {
    const userId = claimInstance(body);
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
