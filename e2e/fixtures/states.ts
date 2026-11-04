import type { Page } from "@playwright/test";

/** PR12 forced states: stub `/api/sources/<source>` so a page renders one state deterministically. */
export const SOURCE_STATES = {
  "todos-error": { path: "/todos", source: "todos", status: { source: "todos", label: "Todos", state: "error", error: "Upstream returned 502" } },
  "skylight-unconfigured": { path: "/skylight", source: "skylight", status: { source: "skylight", label: "Skylight", state: "unconfigured" } },
} as const;

export async function forceSourceState(page: Page, name: keyof typeof SOURCE_STATES) {
  const s = SOURCE_STATES[name];
  await page.route(new RegExp(`/api/sources/${s.source}(\\?.*)?$`), (route) => route.fulfill({ json: { status: s.status } }));
  // Todos also lists Skylight chores: keep the mock's clock-dependent chores out of the state shots.
  if (s.path === "/todos")
    await page.route(/\/api\/sources\/skylight(\?.*)?$/, (route) =>
      route.fulfill({ json: { status: { source: "skylight", label: "Skylight", state: "unconfigured" } } }),
    );
  return s.path;
}
