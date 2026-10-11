import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/settings/configuration/route";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { encryptConfiguration } from "@/server/config-transfer";

const password = "configuration-fixture-password";
let admin: string;
let adult: string;
beforeEach(() => {
  __setTestDatabase();
  const owner = claimInstance({ setupCode: "TESTCODE", name: "Fixture", passcode: "fixture-passcode" });
  admin = createSession(owner).token;
  adult = createSession(createPerson({ name: "Adult", username: "adult", role: "adult", passcode: "fixture-adult" }, owner).id).token;
});
async function call(body: unknown, token: string | null = admin, csrf = true, origin = "http://jarvis.test") {
  const req = new NextRequest("http://jarvis.test/api/settings/configuration", {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(token ? { cookie: `jarvis_session=${token}` } : {}), ...(csrf ? { "x-jarvis-csrf": "1" } : {}) },
    body: JSON.stringify(body),
  });
  const res = await POST(req, { params: Promise.resolve({}) });
  return { status: res.status, headers: res.headers, body: await res.json() };
}
it("requires admin, CSRF and same origin for every operation before processing secrets", async () => {
  for (const operation of ["export", "preview", "apply"]) {
    const body = { operation, password };
    expect((await call(body, null)).status).toBe(401);
    expect((await call(body, adult)).status).toBe(403);
    expect((await call(body, admin, false)).status).toBe(403);
    expect((await call(body, admin, true, "https://evil.invalid")).status).toBe(403);
  }
});
it("serves no-store encrypted export and sanitized preview; explicitly applies disabled configuration", async () => {
  saveIntegration("hermes", { config: { baseUrl: "https://fixture.invalid" }, secrets: { apiKey: "private-fixture" } });
  const exported = await call({ operation: "export", password, includeSecrets: true });
  expect(exported.status).toBe(200);
  expect(exported.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(exported.body)).not.toContain("private-fixture");
  const request = { password, file: exported.body.file, replaceExisting: true };
  const preview = await call({ operation: "preview", ...request });
  expect(preview.status).toBe(200);
  expect(JSON.stringify(preview.body)).not.toMatch(/private-fixture|https:\/\/fixture/);
  expect((await call({ operation: "apply", ...request, revision: preview.body.revision })).body).toEqual({ applied: 1, preserved: 0 });
  expect(getDb().select().from(schema.integrations).get()?.enabled).toBe(false);
});
it("rejects a different encrypted file or replacement choice after preview without writes", async () => {
  const data = { version: 1, integrations: [{ kind: "hermes", config: { baseUrl: "https://previewed.invalid" }, secrets: {} }] };
  const file = await encryptConfiguration(data, password);
  const changedFile = await encryptConfiguration(
    { ...data, integrations: [{ ...data.integrations[0], config: { baseUrl: "https://changed.invalid" } }] },
    password,
  );
  const preview = await call({ operation: "preview", password, file, replaceExisting: false });
  expect(preview.status).toBe(200);
  for (const change of [
    { file: changedFile, replaceExisting: false },
    { file, replaceExisting: true },
  ]) {
    expect((await call({ operation: "apply", password, revision: preview.body.revision, ...change })).status).toBe(409);
    expect(getDb().select().from(schema.integrations).all()).toEqual([]);
  }
  expect((await call({ operation: "apply", password, file, replaceExisting: false, revision: preview.body.revision })).status).toBe(200);
});
it("bounds request streams and rejects plaintext/unknown schema without logging", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await call({ operation: "export", password, extraSecret: "private-fixture" })).status).toBe(400);
    expect((await call({ operation: "preview", password, file: "not encrypted" })).body.error).toBe("Invalid configuration file or password");
    expect((await call({ operation: "preview", password, file: "x".repeat(200000) })).status).toBe(413);
    const file = await encryptConfiguration({ version: 1, integrations: [] }, password);
    expect((await call({ operation: "preview", password: "wrong-password-fixture", file })).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
