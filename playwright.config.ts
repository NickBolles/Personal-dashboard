import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { appPort, appUrl, authState, mockPort, mockUrl, serverCount, usageFile } from "./e2e/servers";

/** This worker's app/mock URLs (server slot = TEST_PARALLEL_INDEX, see e2e/servers.ts). */
export const BASE_URL = appUrl();
export const MOCK_URL = mockUrl();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const WORKERS = serverCount();
// Workers inherit this, so they build the same test list (one onboarding per server) as the runner.
process.env.E2E_WORKERS = String(WORKERS);

/**
 * E2E runs the production build against the bundled mock upstreams (Hermes, Paperclip, Home Assistant, Skylight,
 * Google Tasks). Every worker gets its OWN app server + mock upstream with a fresh data dir and its own signed-in
 * state (e2e/servers.ts), so `--workers N` (or E2E_WORKERS=N) runs N isolated stacks side by side. Files keep their
 * test order inside a worker (fullyParallel off); a11y/visual opt into test-level parallelism (they stub what they
 * show). CI shards the run across jobs and merges the blob reports (docs/ci.md).
 */
const reporter: PlaywrightTestConfig["reporter"] = process.env.CI
  ? [["github"], ["list"], process.env.E2E_BLOB ? ["blob"] : ["html", { open: "never" }]]
  : [["list"]];

type WebServer = Extract<NonNullable<PlaywrightTestConfig["webServer"]>, unknown[]>[number];
const webServer: WebServer[] = Array.from({ length: WORKERS }, (_, i): WebServer[] => [
  {
    command: `node mock-upstreams/server.mjs`,
    url: `${mockUrl(i)}/__mock/health`,
    env: { MOCK_PORT: String(mockPort(i)), MOCK_SPEED: "80" },
    reuseExistingServer: false,
    name: `mock-${i}`,
  },
  {
    command: `node scripts/e2e-server.mjs`,
    url: `${appUrl(i)}/api/health`,
    env: {
      PORT: String(appPort(i)),
      JARVIS_MOCK_UPSTREAM_URL: mockUrl(i),
      JARVIS_ANTHROPIC_BASE_URL: `${mockUrl(i)}/anthropic`,
      // GitHub reads go to the mock (tests never reach api.github.com).
      JARVIS_GITHUB_API_URL: `${mockUrl(i)}/github`,
      // Settings → Agents e2e: the mock Hermes' momentumchief profile key (mock-upstreams/hermes.mjs MOCK_PROFILE_KEYS).
      JARVIS_HERMES_KEY_MOMENTUMCHIEF: "mock-hermes-momentumchief-key-0123456789",
      // Subscription usage meter: e2e/ai-meter.spec.ts writes this snapshot (absolute: the server runs in .next/standalone).
      JARVIS_HERMES_USAGE_FILE: usageFile(i),
      // #141 Drive export (flag ON in e2e only) against the mock Drive + OAuth endpoints
      JARVIS_ENABLE_DRIVE_EXPORT: "1",
      JARVIS_DRIVE_CLIENT_ID: "mock-drive-client.apps.googleusercontent.com",
      JARVIS_DRIVE_CLIENT_SECRET: "mock-drive-secret",
      JARVIS_DRIVE_API_URL: `${mockUrl(i)}/gdrive`,
      JARVIS_DRIVE_AUTH_URL: `${mockUrl(i)}/gdrive/oauth/authorize`,
      JARVIS_DRIVE_TOKEN_URL: `${mockUrl(i)}/gdrive/oauth/token`,
      JARVIS_DRIVE_REVOKE_URL: `${mockUrl(i)}/gdrive/oauth/revoke`,
      // #142 offline Bible: fixture pack (66 one-verse books + John 3/15, Psalm 23) pinned by its own checksum
      JARVIS_BIBLE_PACK_URL: `${mockUrl(i)}/bible/engwebp_vpl.zip`,
      JARVIS_BIBLE_PACK_SHA256: "e73a9d4d552f3be40c549c12a99df12ffaf71c2fbce764b96be6ba086c793a7a",
      JARVIS_SETUP_CODE: "E2E-SETUP",
      JARVIS_WORKER_INTERVAL_MS: "3600000",
      JARVIS_SECURE_COOKIES: "false",
      TZ: "America/Chicago",
    },
    timeout: 120_000,
    reuseExistingServer: false,
    name: `app-${i}`,
  },
]).flat();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: WORKERS,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.03, animations: "disabled", caret: "hide" } },
  reporter,
  // Baselines are generated in the pinned Playwright container (see .github/workflows/visual-baselines.yml)
  // so fonts match CI; local runs write to a git-ignored folder.
  snapshotPathTemplate: `{testDir}/__screenshots__/${process.env.VISUAL_BASELINE_SET ?? (process.env.CI ? "ci" : "local")}/{projectName}/{testFilePath}/{arg}{ext}`,
  updateSnapshots: process.env.CI ? "none" : "missing",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : undefined,
    timezoneId: "America/Chicago",
    locale: "en-US",
  },
  projects: [
    // One onboarding per server (onboarding.setup.ts); they run side by side.
    { name: "setup", testMatch: /onboarding\.setup\.ts/, fullyParallel: true, use: { ...devices["Pixel 7"], browserName: "chromium" } },
    {
      name: "mobile",
      dependencies: ["setup"],
      testIgnore: /onboarding\.setup\.ts/,
      use: { ...devices["Pixel 7"], browserName: "chromium", storageState: authState() },
    },
    {
      name: "mobile-320",
      dependencies: ["setup"],
      testMatch: /(a11y|visual)\.spec\.ts/,
      use: {
        viewport: { width: 320, height: 640 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        browserName: "chromium",
        storageState: authState(),
      },
    },
    {
      name: "desktop",
      dependencies: ["setup"],
      testMatch:
        /(a11y|visual|chat|chat-panel|chat-files|keyboard|sidebar|palette-raycast|inline-edits|global-coordinator|pickers|icon-actions|areas-v2|portfolio)\.spec\.ts/,
      use: { viewport: { width: 1280, height: 800 }, browserName: "chromium", storageState: authState() },
    },
  ],
  webServer,
});
