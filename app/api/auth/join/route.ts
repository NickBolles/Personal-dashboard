import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "@/server/http/api";
import { clientKey } from "@/server/http/origin";
import { audit } from "@/server/audit";
import { AuthError, checkThrottle, createSession, recordFailure, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth";
import { invitePreview, redeemInvite } from "@/server/people";

/** Who an invite is for, so the join page can greet them. Throttled like login. */
export const GET = api(
  ({ req }) => {
    const key = `join:${clientKey(req)}`;
    checkThrottle(key);
    const who = invitePreview(req.nextUrl.searchParams.get("code") ?? "");
    if (!who) {
      recordFailure(key);
      throw new AuthError("bad_invite", "That invite is wrong, used or expired. Ask for a new one.");
    }
    return who;
  },
  { public: true },
);

const schema = z.object({ code: z.string().min(4).max(40), passcode: z.string().min(4).max(200) });

/** Accept an invite: choose a passcode and sign in. */
export const POST = api<z.infer<typeof schema>>(
  ({ req, body, correlationId }) => {
    const key = `join:${clientKey(req)}`;
    checkThrottle(key);
    let user;
    try {
      user = redeemInvite(body.code, body.passcode);
    } catch (err) {
      if (err instanceof AuthError && err.code === "bad_invite") recordFailure(key);
      throw err;
    }
    audit({ actor: user.id, action: "people.joined", result: "ok", correlationId });
    const s = createSession(user.id, req.headers.get("user-agent"));
    const res = NextResponse.json({ ok: true, username: user.username });
    res.cookies.set(SESSION_COOKIE, s.token, sessionCookieOptions(s.expiresAt));
    return res;
  },
  { public: true, body: schema },
);
