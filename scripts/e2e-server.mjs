// Starts the standalone production build on a throwaway data directory for E2E.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

execFileSync(process.execPath, ["scripts/prepare-standalone.mjs"], { stdio: "inherit" });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-e2e-"));
const env = { ...process.env, JARVIS_DATA_DIR: dir, HOSTNAME: "127.0.0.1", PORT: process.env.PORT ?? "3200", NODE_ENV: "production" };
console.log(`[e2e] data dir ${dir}`);
const child = spawn(process.execPath, ["server.js"], { cwd: ".next/standalone", env, stdio: "inherit" });
const stop = () => {
  child.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
