import { NextResponse, type NextRequest } from "next/server";
import { api, checkCsrf, readBodyCapped } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { bearerToken, resolveUser, SESSION_COOKIE, userById, type CurrentUser } from "@/server/auth";
import { checkThrottle, recordFailure } from "@/server/auth/throttle";
import { clientIp } from "@/server/http/origin";
import { CAPTURE_LIMITS, captureFieldsSchema, type CaptureChannel } from "@/lib/ai";
import { CAPTURE_TOKEN_PREFIX, captureTokenFromBearer, checkTokenRate, createCapture, type IncomingFile } from "@/server/capture";
import { inboxEntry } from "@/server/work/inbox";

export const dynamic = "force-dynamic";

/**
 * Quick capture (text/URL/images) → Work inbox, with AI triage when allowed.
 * Its own authentication, in this order: a capture token (jcap_…, capture-only,
 * rate-limited), a paired-phone device token (jdv_…), or the browser session
 * with an explicit CSRF check. Multipart (files[]) or JSON.
 */
export const POST = api(
  async ({ req, correlationId }) => {
    const { user, token, channel } = authenticate(req);
    if (!user.capabilities.has("work.use")) throw new HttpError(403, "forbidden", "You don't have access to that.");
    if (token) {
      const rate = checkTokenRate(token);
      if (!rate.ok)
        return NextResponse.json(
          { error: "Too many captures for this token", code: "rate_limited" },
          { status: 429, headers: { "retry-after": String(rate.retryAfter), "cache-control": "no-store" } },
        );
    }
    const { fields, files } = await readCapture(req);
    const parsed = captureFieldsSchema.parse({ ...fields, channel: fields.channel ?? channel });
    const r = createCapture(user, parsed, files, {
      channel: (parsed.channel ?? channel) as CaptureChannel,
      deviceId: user.deviceId ?? null,
      token,
      correlationId,
    });
    return NextResponse.json(
      { entry: inboxEntry(user.id, r.entryId), triage: r.triage, ...(r.reason ? { reason: r.reason } : {}) },
      { status: r.created ? 201 : 200, headers: { "cache-control": "no-store" } },
    );
  },
  { public: true, csrf: false },
);

function authenticate(req: NextRequest): { user: CurrentUser; token: ReturnType<typeof captureTokenFromBearer>; channel: CaptureChannel } {
  const bearer = bearerToken(req.headers);
  if (bearer?.startsWith(CAPTURE_TOKEN_PREFIX)) {
    const key = `ip:capture:${clientIp(req.headers)}`;
    checkThrottle([key, "global:capture"]);
    const t = captureTokenFromBearer(bearer);
    const user = t ? userById(t.userId, "device") : null;
    if (!t || !user) {
      recordFailure([key, "global:capture"]);
      throw new HttpError(401, "unauthenticated", "Invalid or revoked capture token");
    }
    return { user, token: t, channel: "shortcut" };
  }
  if (bearer === undefined) checkCsrf(req);
  const user = resolveUser(req.headers, req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) throw new HttpError(401, "unauthenticated", "Sign in required");
  return { user, token: null, channel: user.via === "device" ? "android" : "web" };
}

async function readCapture(req: NextRequest): Promise<{ fields: Record<string, string | undefined>; files: IncomingFile[] }> {
  const type = req.headers.get("content-type") ?? "";
  // Size is enforced while streaming, before any multipart parsing.
  const raw = await readBodyCapped(req, CAPTURE_LIMITS.totalBytes + 64 * 1024, "Capture is over 25 MB");
  if (type.startsWith("multipart/form-data")) {
    const form = await new Response(new Uint8Array(raw), { headers: { "content-type": type } }).formData();
    const fields: Record<string, string | undefined> = {};
    for (const k of ["text", "title", "url", "channel", "clientCaptureId", "investigate", "parentId"]) {
      const v = form.get(k);
      if (typeof v === "string" && v !== "") fields[k] = v;
    }
    const files: IncomingFile[] = [];
    for (const v of [...form.getAll("files"), ...form.getAll("files[]")]) {
      if (typeof v === "string") continue;
      if (files.length >= CAPTURE_LIMITS.files) throw new HttpError(413, "too_many_files", `At most ${CAPTURE_LIMITS.files} files`);
      files.push({ name: v.name || "file", type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) });
    }
    return { fields, files };
  }
  if (raw.byteLength > 256 * 1024) throw new HttpError(413, "too_large", "JSON captures are limited to 256 KB");
  let body: unknown = {};
  try {
    body = raw.byteLength ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "bad_json", "Body must be JSON or multipart");
  }
  return { fields: (body ?? {}) as Record<string, string | undefined>, files: [] };
}
