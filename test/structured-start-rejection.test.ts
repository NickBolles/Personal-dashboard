import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("@/integrations/store", () => ({ resolveIntegration: () => ({ enabled: true, config: { baseUrl: "http://fixture" }, secrets: {} }) }));
vi.mock("@/server/settings", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
import { runStructured } from "@/integrations/hermes/structured";
import { setSetting } from "@/server/settings";

// Exercise the actual Hermes client + shared HTTP boundary, not a mocked start.
// An intermediary can return these statuses after the origin accepted the POST.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([429, 503])("retains an ambiguous HTTP %s start failure without leaking its body", async (status) => {
  const requests: string[] = [];
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (method === "POST" && url.pathname === "/v1/runs") {
      return new Response("PRIVATE intermediary response", { status });
    }
    if (method === "POST" || method === "PATCH") {
      return Response.json({ session: { id: "session_fixture" } });
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  await expect(
    runStructured({ source: "skylight", label: "Skylight", task: "fixture", schema: z.object({ ok: z.boolean() }), example: {} }),
  ).rejects.toMatchObject({ kind: status === 429 ? "busy" : "bad_response", message: "Hermes could not complete the Skylight request" });
  // A 429 is retried (same Idempotency-Key, so an accepted run is never started twice); background syncs give up after 2 retries.
  const starts = status === 429 ? 3 : 1;
  expect(requests).toEqual(["POST /api/sessions", "PATCH /api/sessions/session_fixture", ...Array(starts).fill("POST /v1/runs")]);
  const keys = fetch.mock.calls.filter(([u]) => u.pathname === "/v1/runs").map(([, i]) => new Headers(i?.headers).get("idempotency-key"));
  expect(new Set(keys).size).toBe(1);
  expect(setSetting).toHaveBeenCalledExactlyOnceWith(
    "hermes_sync_failure:skylight",
    expect.objectContaining({ status: "unknown", cleanup: "retained", sessionId: "session_fixture" }),
  );
  expect(JSON.stringify(vi.mocked(setSetting).mock.calls)).not.toContain("PRIVATE");
});
