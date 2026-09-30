import "server-only";
import { UpstreamError } from "./errors";

export type UpstreamRequest = {
  source: string;
  baseUrl: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** return the raw Response (for streams) instead of parsed JSON */
  raw?: boolean;
};

export function joinUrl(baseUrl: string, path: string, query?: UpstreamRequest["query"]) {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url;
}

/**
 * Upstream fetch with independent timeouts and consistent error mapping.
 * Never logs headers (they carry credentials).
 */
export async function upstream<T = unknown>(req: UpstreamRequest): Promise<T> {
  const url = joinUrl(req.baseUrl, req.path, req.query);
  const timeout = AbortSignal.timeout(req.timeoutMs ?? 8000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? "GET",
      headers: {
        accept: req.raw ? "text/event-stream" : "application/json",
        ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        ...req.headers,
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal,
      cache: "no-store",
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError") throw new UpstreamError(req.source, "timeout", `${req.source} did not respond in time`);
    if (e.name === "AbortError") throw e;
    throw new UpstreamError(req.source, "unreachable", `Could not reach ${req.source} (${describeCause(e)})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError(req.source, "unauthorized", `${req.source} rejected the credentials (${res.status})`, res.status);
  }
  if (res.status === 404) throw new UpstreamError(req.source, "not_found", `${req.source}: ${url.pathname} not found`, 404);
  if (res.status === 409) throw new UpstreamError(req.source, "conflict", `${req.source}: conflict`, 409);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UpstreamError(req.source, "bad_response", `${req.source} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, res.status);
  }
  if (req.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
  return (await res.json()) as T;
}

function describeCause(e: Error) {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? e.message;
}

/** Run tasks with bounded parallelism. */
export async function boundedAll<T>(tasks: (() => Promise<T>)[], limit = 4): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = { status: "fulfilled", value: await tasks[idx]!() };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
