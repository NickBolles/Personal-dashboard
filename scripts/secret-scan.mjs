#!/usr/bin/env node
// Fails if client bundles or tracked files contain secret-looking values.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PATTERNS = [
  [/pcp_board_[0-9a-f]{48}/g, "Paperclip board key"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "private key"],
  [/ghp_[A-Za-z0-9]{36}/g, "GitHub token"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "Anthropic key"],
  [/sk-[A-Za-z0-9]{40,}/g, "OpenAI-style key"],
  [/AIza[0-9A-Za-z_-]{35}/g, "Google API key"],
  [/eyJhbGciOiJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "JWT"],
  [/ya29\.[A-Za-z0-9_-]{30,}/g, "Google OAuth access token"],
  [/1\/\/0[A-Za-z0-9_-]{30,}/g, "Google OAuth refresh token"],
];
// Known public test values used by the mock server.
const ALLOW = ["pcp_board_mock", "mock-hermes-key", "1//mock-refresh-token", "ya29.mock_"];
const problems = [];

function scan(file, text) {
  for (const [re, label] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (ALLOW.some((a) => m[0].startsWith(a))) continue;
      problems.push(`${file}: ${label} (${m[0].slice(0, 12)}…)`);
    }
  }
}

// 1. Client bundles: nothing server-only may ship to the browser.
const staticDir = ".next/static";
// Env var *names* appear in the connection UI on purpose; these markers indicate server modules leaking.
const serverOnlyMarkers = ["JARVIS_SECRET_KEY", "better-sqlite3", "secret.key", "aes-256-gcm", "mock-client-secret"];
if (fs.existsSync(staticDir)) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(staticDir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(f, "utf8");
    scan(f, text);
    for (const marker of serverOnlyMarkers) if (text.includes(marker)) problems.push(`${f}: server-only reference "${marker}" in client bundle`);
  }
} else {
  console.warn("[secret-scan] no .next/static — run a build to scan client bundles");
}

// 2. Tracked files.
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const f of files) {
  if (/\.(png|jpg|ico|zip|lock)$/.test(f) || f === "package-lock.json") continue;
  try {
    scan(f, fs.readFileSync(f, "utf8"));
  } catch {
    /* deleted */
  }
}

if (problems.length) {
  console.error("Secret scan failed:\n" + problems.map((p) => ` - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`[secret-scan] OK (${files.length} tracked files${fs.existsSync(staticDir) ? " + client bundles" : ""})`);
