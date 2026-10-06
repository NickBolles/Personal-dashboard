import "server-only";
import type { IntegrationKind } from "./registry";

/**
 * Credentials for the bundled mock upstream server (mock-upstreams/). These are
 * public test values, not secrets. Only offered when JARVIS_MOCK_UPSTREAM_URL is set.
 */
export const MOCK = {
  hermesKey: "mock-hermes-key-0123456789",
  paperclipKey: "pcp_board_mock000000000000000000000000000000000000000000",
  haToken: "mock-ha-long-lived-token",
  skylightRefresh: "sk_rt_initial_mock",
  googleClientId: "mock-client.apps.googleusercontent.com",
  googleClientSecret: "mock-client-secret",
  googleRefresh: "1//mock-refresh-token",
  compassToken: "mock-compass-token",
  monarchToken: "mock-monarch-session-token",
};

export type Preset = { config: Record<string, string>; secrets: Record<string, string> };

export function demoPresets(): Partial<Record<IntegrationKind, Preset>> | null {
  const base = process.env.JARVIS_MOCK_UPSTREAM_URL?.replace(/\/$/, "");
  if (!base) return null;
  return {
    hermes: { config: { baseUrl: `${base}/hermes`, dashboardUrl: "" }, secrets: { apiKey: MOCK.hermesKey } },
    todos: {
      config: {
        provider: "google_tasks",
        clientId: MOCK.googleClientId,
        taskListId: "@default",
        apiBase: `${base}/google`,
        tokenUrl: `${base}/google/token`,
        authUrl: `${base}/google/o/oauth2/v2/auth`,
      },
      secrets: { clientSecret: MOCK.googleClientSecret, refreshToken: MOCK.googleRefresh },
    },
    daily_compass: { config: { mode: "jarvis", windowStart: "00:00", windowEnd: "23:59", reminderTime: "20:00" }, secrets: {} },
    home_assistant: { config: { baseUrl: `${base}/ha` }, secrets: { token: MOCK.haToken } },
    skylight: {
      config: { mode: "direct", baseUrl: `${base}/skylight`, frameId: "", apiVersion: "2026-06-01" },
      secrets: { refreshToken: MOCK.skylightRefresh },
    },
    paperclip: { config: { baseUrl: `${base}/paperclip`, uiUrl: "https://paperclip.example.com", companyId: "" }, secrets: { apiKey: MOCK.paperclipKey } },
    finance: { config: { balanceSource: "monarch", monarchUrl: `${base}/monarch`, refreshWaitSeconds: "5" }, secrets: { monarchToken: MOCK.monarchToken } },
  };
}
