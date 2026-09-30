import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "@/server/http/api";
import { createSession, SESSION_COOKIE, sessionCookieOptions, verifyLogin } from "@/server/auth";

export const POST = api(
  ({ body, req }) => {
    const key = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const owner = verifyLogin(body.passcode, key);
    const s = createSession(owner.id, req.headers.get("user-agent"));
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, s.token, sessionCookieOptions(s.expiresAt));
    return res;
  },
  { public: true, body: z.object({ passcode: z.string().min(1).max(200) }) },
);
