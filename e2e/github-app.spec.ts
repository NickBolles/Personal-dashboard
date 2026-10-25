import crypto from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, MOCK_URL } from "./helpers";

/**
 * GitHub App manifest flow (docs/github-app.md): Create GitHub App → (mock)
 * GitHub confirmation page → callback → stored; installations, allowlist,
 * App-signed check_suite webhook → "merged + checks red" on a linked PR.
 * github.com is intercepted with page.route, so nothing leaves the machine.
 */

async function api<T = unknown>(page: Page, method: "get" | "post" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const r = await page.request[method](path, { data, headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

/** Stand-in for github.com/settings/apps/new: take the POSTed manifest, show a confirm page linking to the redirect URL. */
async function interceptGithub(page: Page, seen: { manifest?: Record<string, unknown>; action?: string }) {
  await page.route("https://github.com/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== "POST" || !/\/settings\/apps\/new$/.test(url.pathname)) return route.fulfill({ status: 404, body: "not mocked" });
    const manifest = new URLSearchParams(req.postData() ?? "").get("manifest") ?? "";
    seen.manifest = JSON.parse(manifest);
    seen.action = url.pathname;
    const r = await page.request.post(`${MOCK_URL}/github/__mock/manifest`, { data: { manifest } });
    const { code, redirect_url } = (await r.json()) as { code: string; redirect_url: string };
    const back = `${redirect_url}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><title>Create GitHub App</title><main><h1>Create GitHub App for NickBolles</h1><a href="${back}">Create GitHub App</a></main></html>`,
    });
  });
}

// A failure mid-test must not leave an App behind: later specs (and work.spec's "Add a GitHub token" hint) expect the token-only world.
test.afterEach(async ({ page }) => {
  const r = await page.request.get("/api/github");
  if (r.ok() && ((await r.json()) as { app: unknown }).app) await page.request.delete("/api/github/app", { headers: { "x-jarvis-csrf": "1" } });
  await page.request.post(`${MOCK_URL}/github/__mock/installations`, { data: { installations: [] } });
});

test("create GitHub App via the manifest flow; installations, allowlist, App-signed webhooks", async ({ page }) => {
  // Start clean (another run may have left an App).
  const before = await api<{ app: unknown }>(page, "get", "/api/github");
  if (before.app) await api(page, "delete", "/api/github/app");
  await page.request.post(`${MOCK_URL}/github/__mock/installations`, { data: { installations: [] } });

  const seen: { manifest?: Record<string, unknown>; action?: string } = {};
  await interceptGithub(page, seen);
  await page.goto("/settings/connections#github");
  const panel = page.locator("#panel-github");
  await expect(panel.getByRole("heading", { name: "GitHub App (recommended)" })).toBeVisible();
  await expect(panel.getByTestId("gh-app-http-warning")).toBeVisible(); // e2e runs on http
  const name = `Jarvis e2e ${Date.now().toString(36)}`;
  await panel.getByLabel("App name").fill(name);
  await panel.getByRole("button", { name: "Create GitHub App" }).click();

  // On (mock) GitHub: the manifest arrived with the read-only permissions; confirm.
  await expect(page.getByRole("heading", { name: "Create GitHub App for NickBolles" })).toBeVisible();
  expect(seen.action).toBe("/settings/apps/new");
  expect(seen.manifest).toMatchObject({
    name,
    public: true,
    redirect_url: expect.stringMatching(/\/api\/github\/app\/callback$/),
    hook_attributes: { url: expect.stringMatching(/\/api\/work\/github\/webhook$/), active: true },
    default_permissions: { metadata: "read", pull_requests: "read", issues: "read", checks: "read", statuses: "read", actions: "read" },
    default_events: ["pull_request", "pull_request_review", "issues", "check_suite", "workflow_run"],
  });
  await page.getByRole("link", { name: "Create GitHub App" }).click();

  // Back in Jarvis: stored, no secrets in the page or the API.
  await expect(page).toHaveURL(/\/settings\/connections#github$/);
  await expect(page.getByTestId("gh-app-notice")).toContainText("GitHub App created");
  await expect(panel.getByTestId("gh-app")).toContainText(name);
  await expect(panel.getByTestId("gh-app-install")).toHaveAttribute("href", /^https:\/\/github\.com\/apps\/jarvis-e2e-[a-z0-9]+\/installations\/new$/);
  const mockApp = (await (await page.request.get(`${MOCK_URL}/github/__mock/app`)).json()) as { webhookSecret: string; slug: string };
  const settingsText = await (await page.request.get("/api/github")).text();
  expect(settingsText).not.toContain(mockApp.webhookSecret);
  expect(settingsText).not.toContain("PRIVATE KEY");
  expect(settingsText).not.toContain("mock-client-secret");
  expect(await page.content()).not.toContain(mockApp.webhookSecret);

  // Installed on the user, the org and a stranger: Refresh lists them; the stranger is flagged.
  await page.request.post(`${MOCK_URL}/github/__mock/installations`, {
    data: {
      installations: [
        { id: 175021456, account: "NickBolles", type: "User", selection: "selected", repos: ["Personal-dashboard"] },
        { id: 175021594, account: "momentumbets", type: "Organization", selection: "selected", repos: ["mb-stack"] },
        { id: 175029999, account: "evil-corp", type: "Organization", selection: "all", repos: ["x"] },
      ],
    },
  });
  await panel.getByRole("button", { name: "Refresh installations" }).click();
  const rows = panel.getByTestId("gh-installation");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "NickBolles" })).toContainText("In use");
  await expect(rows.filter({ hasText: "NickBolles" })).toContainText("Repos: Personal-dashboard");
  await expect(rows.filter({ hasText: "evil-corp" })).toContainText("Ignored: not in the allowlist");
  await expect(rows.filter({ hasText: "momentumbets" })).toContainText("Ignored"); // default allowlist: token owners + App owner
  await panel.getByLabel("Accounts Jarvis accepts").fill("nickbolles, momentumbets");
  await panel.getByRole("button", { name: "Save allowlist" }).click();
  await expect(rows.filter({ hasText: "momentumbets" })).toContainText("In use");
  await expect(rows.filter({ hasText: "evil-corp" })).toContainText("Ignored");
  await expectNoHorizontalOverflow(page);
  const axe = await new AxeBuilder({ page: page as never }).include("#panel-github").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  // A linked PR: merged via an App-signed pull_request, then check_suite → "checks red". evil-corp deliveries are ignored.
  const nonce = Math.floor(Date.now() / 1000) % 100000;
  const { item: area } = await api<{ item: { id: string } }>(page, "post", "/api/work/items", { kind: "area", title: `App e2e ${nonce}` });
  const { item } = await api<{ item: { id: string } }>(page, "post", "/api/work/items", { kind: "thread", title: `CI watch ${nonce}`, parentId: area.id });
  await api(page, "post", `/api/work/items/${item.id}/links`, { kind: "github_pr", url: `https://github.com/momentumbets/mb-stack/pull/${nonce}` });
  const send = (event: string, payload: unknown, delivery = crypto.randomUUID()) => {
    const body = JSON.stringify(payload);
    return page.request.post("/api/work/github/webhook", {
      data: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", mockApp.webhookSecret).update(body).digest("hex")}`,
      },
    });
  };
  const repo = { full_name: "momentumbets/mb-stack", owner: { login: "momentumbets" } };
  // The PR as GitHub reports it: merged, head at the commit the check_suite below is for (Jarvis ignores runs for older heads).
  const sha = crypto.createHash("sha1").update(String(nonce)).digest("hex");
  await page.request.post(`${MOCK_URL}/github/__mock/pr`, {
    data: { owner: "momentumbets", repo: "mb-stack", number: nonce, state: "closed", merged: true, title: `CI watch ${nonce}`, sha },
  });
  const merged = await send("pull_request", {
    action: "closed",
    installation: { id: 175021594 },
    repository: repo,
    pull_request: { number: nonce, state: "closed", merged: true },
  });
  expect(await merged.json()).toMatchObject({ linked: 1, changed: 1 });
  await page.request.post(`${MOCK_URL}/github/__mock/checks`, {
    data: {
      owner: "momentumbets",
      repo: "mb-stack",
      sha,
      suites: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ],
    },
  });
  const checks = await send("check_suite", {
    action: "completed",
    installation: { id: 175021594 },
    repository: repo,
    check_suite: { head_sha: sha, status: "completed", conclusion: "success", pull_requests: [{ number: nonce }] },
  });
  expect(await checks.json()).toMatchObject({ linked: 1, changed: 1 }); // combined state read with the installation token: one suite failed
  const evil = await send("pull_request", {
    action: "closed",
    installation: { id: 175029999 },
    repository: { full_name: "evil-corp/x", owner: { login: "evil-corp" } },
    pull_request: { number: 1, state: "closed", merged: true },
  });
  expect(evil.status()).toBe(202);
  expect(await evil.json()).toMatchObject({ reason: "installation_not_allowed" });
  const requests = (await (await page.request.get(`${MOCK_URL}/github/__mock/requests`)).json()) as { requests: { method: string; path: string }[] };
  expect(requests.requests.filter((r) => r.method !== "GET").every((r) => /\/conversions$|\/access_tokens$/.test(r.path))).toBe(true);

  await page.goto(`/work?item=${item.id}`);
  await expect(page.getByRole("heading", { level: 2, name: `CI watch ${nonce}` })).toBeVisible();
  // Phones fold Links into a disclosure; open it if collapsed.
  const links = page.getByTestId("work-links");
  if ((await links.evaluate((el) => el.tagName)) === "DETAILS" && !(await links.evaluate((el) => (el as HTMLDetailsElement).open)))
    await links.locator("summary").click();
  await expect(links.getByText("merged", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("link-checks")).toHaveText("checks red");

  // Forget the App (UI) so later specs see the old world.
  await page.goto("/settings/connections#github");
  await panel.getByRole("button", { name: "Forget this App" }).click();
  await page.getByRole("dialog", { name: "Forget the GitHub App?" }).getByRole("button", { name: "Forget App" }).click();
  await expect(panel.getByRole("button", { name: "Create GitHub App" })).toBeVisible();
  await page.request.post(`${MOCK_URL}/github/__mock/installations`, { data: { installations: [] } });
});

test("a stale or foreign callback is refused with a clear message", async ({ page }) => {
  await page.goto("/api/github/app/callback?code=whatever&state=not-a-real-state");
  await expect(page).toHaveURL(/\/settings\/connections#github$/);
  await expect(page.getByTestId("gh-app-notice")).toContainText("expired or wasn't started from this session");
  expect((await api<{ app: unknown }>(page, "get", "/api/github")).app).toBeNull();
});
