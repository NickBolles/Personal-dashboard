"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

/** Browser → BFF fetch. Adds the CSRF header required on every mutation. */
export async function apiFetch<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        "x-jarvis-csrf": "1",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, typeof navigator !== "undefined" && !navigator.onLine ? "You're offline" : "Couldn't reach Jarvis", "network");
  }
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string; detail?: unknown };
    if (res.status === 401 && d.code === "unauthenticated" && typeof window !== "undefined") {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    throw new ApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code, d.detail);
  }
  return data as T;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(p: string, signal?: AbortSignal) => apiFetch<T>(p, { signal }),
  post: <T>(p: string, body?: unknown) => apiFetch<T>(p, { method: "POST", body: body ?? {} }),
  put: <T>(p: string, body: unknown) => apiFetch<T>(p, { method: "PUT", body }),
  patch: <T>(p: string, body: unknown) => apiFetch<T>(p, { method: "PATCH", body }),
  del: <T>(p: string, body?: unknown) => apiFetch<T>(p, { method: "DELETE", body: body ?? {} }),
};

export function newIdempotencyKey(prefix = "jv") {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}
