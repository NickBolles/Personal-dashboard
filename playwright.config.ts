import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 4020);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

/**
 * E2E runs the production build against the bundled mock upstreams
 * (Hermes, Paperclip, Home Assistant, Skylight, Google Tasks) with a fresh
 * data directory. Workers are constrained to 1: tests share one server.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.03, animations: "disabled", caret: "hide" } },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
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
    { name: "setup", testMatch: /onboarding\.setup\.ts/, use: { ...devices["Pixel 7"], browserName: "chromium" } },
    {
      name: "mobile",
      dependencies: ["setup"],
      testIgnore: /onboarding\.setup\.ts/,
      use: { ...devices["Pixel 7"], browserName: "chromium", storageState: "e2e/.auth/state.json" },
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
        storageState: "e2e/.auth/state.json",
      },
    },
    {
      name: "desktop",
      dependencies: ["setup"],
      testMatch: /(a11y|visual|chat|keyboard)\.spec\.ts/,
      use: { viewport: { width: 1280, height: 800 }, browserName: "chromium", storageState: "e2e/.auth/state.json" },
    },
  ],
  webServer: [
    {
      command: `node mock-upstreams/server.mjs`,
      url: `${MOCK_URL}/__mock/health`,
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_SPEED: "80" },
      reuseExistingServer: false,
    },
    {
      command: `node scripts/e2e-server.mjs`,
      url: `${BASE_URL}/api/health`,
      env: {
        PORT: String(PORT),
        JARVIS_MOCK_UPSTREAM_URL: MOCK_URL,
        JARVIS_SETUP_CODE: "E2E-SETUP",
        JARVIS_WORKER_INTERVAL_MS: "3600000",
        JARVIS_SECURE_COOKIES: "false",
        TZ: "America/Chicago",
      },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
