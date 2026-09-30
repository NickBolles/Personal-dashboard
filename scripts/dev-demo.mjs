// Local demo: mock upstreams + `next dev` with demo presets. Setup code: DEMO
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  JARVIS_DATA_DIR: process.env.JARVIS_DATA_DIR ?? "./data-dev",
  JARVIS_SETUP_CODE: "DEMO",
  JARVIS_MOCK_UPSTREAM_URL: "http://127.0.0.1:4010",
  JARVIS_WORKER_INTERVAL_MS: "20000",
};
const kids = [
  spawn(process.execPath, ["mock-upstreams/server.mjs"], { env, stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev"], { env, stdio: "inherit" }),
];
console.log("[demo] http://localhost:3000 — setup code DEMO");
const stop = () => kids.forEach((k) => k.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
