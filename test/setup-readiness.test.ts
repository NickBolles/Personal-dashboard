import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const compose = fs.readFileSync("docker-compose.yml", "utf8");
const workflow = fs.readFileSync(".github/workflows/android.yml", "utf8");

describe("deployment boundaries", () => {
  it("does not publish production ports; local access is an explicit loopback override", () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(fs.readFileSync("docker-compose.local.yml", "utf8")).toContain("127.0.0.1:${JARVIS_PORT:-3000}:3000");
  });
});

describe("Android release signing", () => {
  // Execute the actual workflow shell preflight, not a reimplementation.
  function check(release: boolean, missing?: string) {
    const block = workflow.match(/- name: Validate release signing[\s\S]*?run: \|\n([\s\S]*?)(?=\n      -)/)?.[1];
    expect(block, "signing preflight must precede Java/Gradle setup").toBeTruthy();
    expect(workflow.indexOf("Validate release signing")).toBeLessThan(workflow.indexOf("actions/setup-java"));
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH!,
      RELEASE: String(release),
      KEYSTORE_B64: "fixture",
      KEYSTORE_PASSWORD: "fixture",
      KEY_ALIAS: "fixture",
      KEY_PASSWORD: "fixture",
    };
    if (missing) env[missing] = "";
    return spawnSync("bash", ["-e", "-c", block!.replace(/^          /gm, "")], { env, encoding: "utf8" });
  }
  it.each(["KEYSTORE_B64", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"])("rejects a release missing %s", (missing) => {
    expect(check(true, missing).status).not.toBe(0);
  });
  it("allows persistent releases and non-release CI without secrets", () => {
    expect(check(true).status).toBe(0);
    expect(check(false, "KEYSTORE_B64").status).toBe(0);
  });
  it("also gates publishing on persistent signing", () => {
    expect(workflow).toMatch(/name: Publish release\n\s+if:.*inputs.release.*steps.key.outputs.persistent == 'true'/);
  });
});
