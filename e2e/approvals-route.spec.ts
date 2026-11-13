import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";
import { phase3Decision, stubPhase3Shell } from "./fixtures/phase3-gaps";

test("alder approvals tab opens a decision deep link and reviews an option without writes", async ({ page }) => {
  await stubPhase3Shell(page);
  await page.route(/\/api\/notifications(?:\?.*)?$/, (r) => r.fulfill({ json: { notifications: [], unread: 0 } }));
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (r) => r.fulfill({ json: { entries: [phase3Decision], count: 1 } }));
  await page.route(/\/api\/work\/decisions\/item(?::|%3A)wk_alder_review$/i, (r) => r.fulfill({ json: { entry: phase3Decision } }));
  const writes: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/(work|coordinator)\//.test(r.url()) && !["GET", "HEAD"].includes(r.method())) writes.push(r.url());
  });
  await page.goto("/alerts");
  await page.getByRole("radio", { name: /^Approvals\s*1$/ }).click();
  const approval = page.getByRole("region", { name: "Pending approvals" }).getByRole("link", { name: /Use the alder rollout route/ });
  await expect(approval).toHaveAttribute("href", "/decisions/item%3Awk_alder_review");
  await approval.click();
  await expect(page.getByRole("heading", { name: phase3Decision.question })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open item", exact: true })).toHaveAttribute("href", phase3Decision.href);
  // The decision is risk-flagged: a choice arms in place (no dialog) and nothing is written until Confirm.
  const card = page.getByTestId("decision-card");
  await card.getByRole("button", { name: /^Alder pilot/ }).click();
  const confirm = card.getByRole("group", { name: "Confirm answer" });
  await expect(confirm.getByRole("button", { name: "Confirm: Alder pilot", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Confirm decision" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("alder missing decision shows the kit empty state", async ({ page }) => {
  await stubPhase3Shell(page);
  await page.route(/\/api\/work\/decisions\/item(?::|%3A)wk_alder_missing$/i, (r) =>
    r.fulfill({ status: 404, json: { code: "not_found", error: "Not found" } }),
  );
  await page.goto("/decisions/item%3Awk_alder_missing");
  await expect(page.getByText("Decision not found", { exact: true })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
});
