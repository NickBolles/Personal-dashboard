import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { HermesSessionClient } from "@/integrations/hermes/client";

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hermes`;
});
afterAll(() => server?.close());

it("sends and validates oldest/latest pagination over HTTP with chronological results", async () => {
  const c = { baseUrl, apiKey: "mock-hermes-key-0123456789" };
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    const all = await HermesSessionClient.messages(c, "sess_morning", { limit: 500, offset: 0, order: "oldest", includeCompacted: true });
    expect(all.pagination).toEqual({ limit: 500, offset: 0, order: "oldest", returned: 4 });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("include_compacted=true");
    const oldest = await HermesSessionClient.messages(c, "sess_morning", { limit: 2, offset: 1, order: "oldest" });
    const latest = await HermesSessionClient.messages(c, "sess_morning", { limit: 2, offset: 1, order: "latest" });
    expect(oldest.data.map((m) => m.id)).toEqual(all.data.slice(1, 3).map((m) => m.id));
    expect(latest.data.map((m) => m.id)).toEqual(all.data.slice(1, 3).map((m) => m.id));
  } finally {
    fetchSpy.mockRestore();
  }
});
