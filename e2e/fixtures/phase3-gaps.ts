import type { Page } from "@playwright/test";
import type { CoordinatorsResponse } from "../../lib/coordinator-settings";
import type { DecisionEntry } from "../../lib/decisions";

export const phase3Decision: DecisionEntry = {
  key: "item:wk_alder_review",
  kind: "item",
  itemId: "wk_alder_review",
  title: "Alder routing review",
  question: "Use the alder rollout route?",
  choices: ["Alder pilot", "Keep current route"],
  href: "/areas?item=wk_alder_review",
  at: "2026-10-29T12:00:00.000Z",
  areaTitle: "Workshop",
  askedBy: "devchief",
};
export const phase3Coordinators: CoordinatorsResponse = {
  budget: { spentUsd: 1.25, reservedUsd: 0.25, budgetUsd: 5 },
  coordinators: [
    {
      profile: "devchief",
      areas: [{ id: "wk_alder_area", title: "Alder workshop", agentMode: "devchief" }],
      scopes: ["work.read", "work.write", "decisions.write", "runs.write"],
      spend: { todayUsd: 0.75, sevenDayUsd: 2.5, estimatedJobs: 2, jobs: 4 },
    },
  ],
};
export async function stubPhase3Shell(page: Page) {
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (r) => r.fulfill({ json: { items: [], linkedConversations: [] } }));
  await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (r) => r.fulfill({ json: { items: {}, active: [] } }));
  await page.route(/\/api\/work\/coordinator\/global(?:\?.*)?$/, (r) => r.fulfill({ json: { area: null } }));
  await page.route(/\/api\/work\/activity(?:\?.*)?$/, (r) => r.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (r) => r.fulfill({ json: { entries: [], count: 0 } }));
  await page.route(/\/api\/notifications\/count$/, (r) => r.fulfill({ json: { unread: 0 } }));
  await page.route(/\/api\/quick-actions(?:\?.*)?$/, (r) => r.fulfill({ json: { actions: [] } }));
  await page.route(/\/api\/hermes\/sessions(?:\?.*)?$/, (r) => r.fulfill({ json: { sessions: [], nextCursor: null } }));
  await page.route(/\/api\/smart\/settings$/, (r) => r.fulfill({ json: { enabled: false, calendarWrites: false } }));
}
export async function stubPhase3Settings(page: Page) {
  await stubPhase3Shell(page);
  await page.route(/\/api\/settings$/, (r) =>
    r.fulfill({ json: { displayName: "Alder owner", timezone: "America/Chicago", refreshIntervalMinutes: 5, hermes: { showToolDetails: false } } }),
  );
  await page.route(/\/api\/auth\/me$/, (r) => r.fulfill({ json: { authMode: "proxy", user: { name: "Alder owner", via: "proxy" } } }));
  await page.route(/\/api\/assistant$/, (r) =>
    r.fulfill({
      json: {
        defaultBackend: "hermes",
        backends: [{ id: "hermes", label: "Hermes", available: true }],
        claude: { model: "claude-sonnet-4-6", effort: "low", keySet: false, keyFromEnv: false },
      },
    }),
  );
  await page.route(/\/api\/hermes\/sessions\/shared$/, (r) => r.fulfill({ json: { conversations: [], unavailable: [] } }));
  await page.route(/\/api\/settings\/agents$/, (r) =>
    r.fulfill({
      json: {
        settings: { routing: true, aguiStream: true, routes: [{ profile: "devchief", keyEnv: null, baseUrl: null }] },
        routes: [
          { profile: "devchief", keyEnv: null, baseUrl: null, effectiveBaseUrl: "https://hermes.example/p/devchief", keyPresent: true, sharedKey: true },
        ],
        hermesConfigured: true,
      },
    }),
  );
  await page.route(/\/api\/settings\/agents\/tokens$/, (r) => r.fulfill({ json: { tokens: [] } }));
  await page.route(/\/api\/settings\/agents\/coordinators$/, (r) => r.fulfill({ json: phase3Coordinators }));
}
