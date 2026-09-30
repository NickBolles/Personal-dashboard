import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import { destroySession, SESSION_COOKIE } from "@/server/auth";

export const POST = api(
  ({ req }) => {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (token) destroySession(token);
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  },
  { public: true },
);
