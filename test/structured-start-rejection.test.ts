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
  ).rejects.toMatchObject({ kind: "bad_response", message: "Hermes could not complete the Skylight request" });
  expect(requests).toEqual(["POST /api/sessions", "PATCH /api/sessions/session_fixture", "POST /v1/runs"]);
  expect(setSetting).toHaveBeenCalledExactlyOnceWith(
    "hermes_sync_failure:skylight",
    expect.objectContaining({ status: "unknown", cleanup: "retained", sessionId: "session_fixture" }),
  );
  expect(JSON.stringify(vi.mocked(setSetting).mock.calls)).not.toContain("PRIVATE");
});
