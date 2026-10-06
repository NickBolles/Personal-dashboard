import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { config } from "@/server/config";
import { AuthError, bearerToken, resolveUser, SESSION_COOKIE, type CurrentUser } from "@/server/auth";
import { newId } from "@/server/crypto";
import { HttpError, UpstreamError } from "./errors";

type Ctx<P> = { params: Promise<P> };

export type ApiContext<B, P> = {
  req: NextRequest;
  user: CurrentUser;
  body: B;
  params: P;
  correlationId: string;
};

type Options<B> = {
  /** skip authentication (health, login, setup) */
  public?: boolean;
  /** false for public endpoints called by the phone app with no cookies at all (pairing) */
  csrf?: boolean;
  body?: ZodType<B>;
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-jarvis-csrf";

/**
 * Origin + custom-header CSRF defence for browser mutations. A cross-site form
 * cannot set custom headers, and cross-origin fetch with one triggers CORS
 * preflight, which we never approve.
 */
export function checkCsrf(req: NextRequest) {
  if (!MUTATING.has(req.method)) return;
  if (req.headers.get(CSRF_HEADER) !== "1") throw new HttpError(403, "csrf", "Missing CSRF header");
  const origin = req.headers.get("origin");
  if (!origin) return; // same-origin fetches from some browsers omit Origin on same-origin requests
  const allowed = new Set<string>();
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  if (host) allowed.add(`${proto}://${host}`);
  allowed.add(req.nextUrl.origin);
  if (config.publicOrigin) allowed.add(config.publicOrigin);
  if (!allowed.has(origin)) throw new HttpError(403, "csrf", "Cross-origin request rejected");
}

export function jsonError(status: number, error: string, code?: string, detail?: unknown) {
  return NextResponse.json({ error, code, detail }, { status, headers: { "cache-control": "no-store" } });
}

export function toErrorResponse(err: unknown, correlationId?: string) {
  if (err instanceof HttpError) return jsonError(err.status, err.message, err.code);
  if (err instanceof AuthError) {
    const status = err.code === "throttled" ? 429 : err.code === "already_claimed" ? 409 : 401;
    return jsonError(status, err.message, err.code);
  }
  if (err instanceof ZodError) {
    return jsonError(
      400,
      "Invalid request",
      "validation",
      err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  if (err instanceof UpstreamError) {
    const status = err.kind === "unauthorized" ? 502 : err.kind === "not_found" ? 404 : err.kind === "conflict" ? 409 : err.kind === "unsupported" ? 501 : 502;
    return jsonError(status, err.message, `upstream_${err.kind}`, { source: err.source });
  }
  console.error(`[jarvis] unhandled error ${correlationId ?? ""}`, err);
  return jsonError(500, "Something went wrong", "internal", { correlationId });
}

export async function readJson(req: NextRequest): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > config.maxBodyBytes) throw new HttpError(413, "too_large", "Request body too large");
  const text = await req.text();
  if (text.length > config.maxBodyBytes) throw new HttpError(413, "too_large", "Request body too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Body must be JSON");
  }
}

export function api<B = undefined, P = Record<string, string>>(
  handler: (ctx: ApiContext<B, P>) => Promise<Response | unknown> | Response | unknown,
  options: Options<B> = {},
) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    const correlationId = req.headers.get("x-correlation-id") ?? newId();
    try {
      // Bearer (paired phone) requests carry no ambient credentials, so CSRF doesn't apply.
      if (bearerToken(req.headers) === undefined && options.csrf !== false) checkCsrf(req);
      let user: CurrentUser | null = null;
      if (!options.public) {
        user = resolveUser(req.headers, req.cookies.get(SESSION_COOKIE)?.value);
        if (!user) return jsonError(401, "Sign in required", "unauthenticated");
      }
      let body = undefined as B;
      if (options.body) body = options.body.parse(await readJson(req));
      const params = (ctx?.params ? await ctx.params : {}) as P;
      const result = await handler({ req, user: user as CurrentUser, body, params, correlationId });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      return toErrorResponse(err, correlationId);
    }
  };
}
