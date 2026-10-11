import { beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase, getDb, getSqlite, schema } from "@/server/db";
import { saveIntegration, publicIntegration } from "@/integrations/store";
import { decryptConfiguration, encryptConfiguration, exportConfiguration, previewConfiguration, applyConfiguration } from "@/server/config-transfer";

const password = "fixture-long-password";
beforeEach(() => {
  __setTestDatabase();
});

describe("encrypted configuration", () => {
  it("round-trips with fresh salt/nonce; secrets are opt-in and preview has no values", async () => {
    saveIntegration("hermes", { config: { baseUrl: "https://fixture.invalid" }, secrets: { apiKey: "fixture-private-value" } });
    const without = await exportConfiguration(password, false);
    expect((await decryptConfiguration(without, password)).integrations[0].secrets).toEqual({});
    const file = await exportConfiguration(password, true);
    expect(file).not.toContain("fixture-private-value");
    expect(file).not.toBe(await exportConfiguration(password, true));
    const data = await decryptConfiguration(file, password);
    expect(data.integrations[0].secrets.apiKey).toBe("fixture-private-value");
    expect(JSON.stringify(previewConfiguration(data, false))).not.toMatch(/fixture-private-value|https:\/\/fixture/);
  });
  it("fails closed for wrong password, tampering, unknown versions and unbounded KDF", async () => {
    const file = await encryptConfiguration({ version: 1, integrations: [] }, password);
    await expect(decryptConfiguration(file, "wrong-password-long")).rejects.toThrow("Invalid configuration file or password");
    for (const patch of [
      { version: 2 },
      { N: 2 ** 30 },
      { cipher: "none" },
      { extra: "no" },
      { tag: Buffer.alloc(16).toString("base64") },
      { salt: Buffer.alloc(32).toString("base64") },
    ]) {
      await expect(decryptConfiguration(JSON.stringify({ ...JSON.parse(file), ...patch }), password)).rejects.toThrow();
    }
    await expect(decryptConfiguration("x".repeat(131073), password)).rejects.toThrow();
    await expect(encryptConfiguration({ version: 1, integrations: [] }, "short")).rejects.toThrow();
  });
  it("rejects unknown payload keys, secret/config confusion and readiness markers", async () => {
    for (const data of [
      { version: 2, integrations: [] },
      { version: 1, integrations: [], users: [] },
      { version: 1, integrations: [{ kind: "hermes", config: { apiKey: "bad" }, secrets: {} }] },
      { version: 1, integrations: [{ kind: "hermes", config: {}, secrets: {}, enabled: true }] },
      { version: 1, integrations: [{ kind: "hermes", config: {}, secrets: {}, lastTestOk: true }] },
      { version: 1, integrations: [{ kind: "hermes", config: { baseUrl: "javascript:bad" }, secrets: {} }] },
    ])
      await expect(encryptConfiguration(data, password)).rejects.toThrow();
  });
  it("preserves existing entries by default; explicit replacement disables and clears readiness", async () => {
    saveIntegration("hermes", { enabled: true, config: { baseUrl: "https://old.invalid", sessionSource: "old" }, secrets: { apiKey: "old-fixture" } });
    getSqlite().prepare("UPDATE integrations SET last_test_ok = 1, last_test_result = '{}' ").run();
    const data = await decryptConfiguration(
      await encryptConfiguration({ version: 1, integrations: [{ kind: "hermes", config: { baseUrl: "https://new.invalid" }, secrets: {} }] }, password),
      password,
    );
    const keep = previewConfiguration(data, false);
    applyConfiguration(data, false, keep.revision);
    expect(publicIntegration("hermes")).toMatchObject({ enabled: true, config: { baseUrl: "https://old.invalid" } });
    const replace = previewConfiguration(data, true);
    applyConfiguration(data, true, replace.revision);
    expect(publicIntegration("hermes")).toMatchObject({
      enabled: false,
      config: { baseUrl: "https://new.invalid", sessionSource: "jarvis" },
      secrets: { apiKey: { set: false } },
    });
    expect(publicIntegration("hermes").lastTest).toBeUndefined();
  });
  it("detects stale preview and rolls back all writes on storage failure", async () => {
    const data = await decryptConfiguration(
      await encryptConfiguration(
        {
          version: 1,
          integrations: [
            { kind: "hermes", config: {}, secrets: {} },
            { kind: "todos", config: {}, secrets: {} },
          ],
        },
        password,
      ),
      password,
    );
    const preview = previewConfiguration(data, false);
    saveIntegration("paperclip", { enabled: false });
    expect(() => applyConfiguration(data, false, preview.revision)).toThrow(/changed/);
    getSqlite().exec("CREATE TRIGGER fail_import BEFORE INSERT ON integrations WHEN NEW.kind = 'todos' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect(() => applyConfiguration(data, false, previewConfiguration(data, false).revision)).toThrow();
    expect(
      getDb()
        .select()
        .from(schema.integrations)
        .all()
        .map((x) => x.kind),
    ).toEqual(["paperclip"]);
  });
});
