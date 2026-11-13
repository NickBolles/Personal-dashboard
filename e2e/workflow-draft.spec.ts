import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/** Workflows W3: "Save chat as workflow" review, "Describe it", and the sandbox "Test a turn". */

async function renameSlug(page: Page, slug: string) {
  const basics = page.getByRole("listitem", { name: "Name & basics" });
  await basics.getByRole("button", { name: "Edit" }).click();
  const box = page.locator("#wf-review-basics");
  const json = JSON.parse(await box.inputValue()) as { slug: string; name: string };
  await box.fill(JSON.stringify({ ...json, slug, name: `${json.name} ${slug}` }));
  await basics.getByRole("button", { name: "Apply" }).click();
}

test("save chat as workflow: review parts, drop one, save as a draft", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const r = await appPost(page, "/api/hermes/sessions", { title: `Lantern evening ${nonce}` });
  expect(r.ok()).toBeTruthy();
  const s = (await r.json()) as { id: string };
  await page.goto(`/chat/${encodeURIComponent(s.id)}`);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Save chat as workflow" }).click();
  await expect(page).toHaveURL(/\/workflows\/new\?fromChat=/);

  const review = page.getByTestId("proposal-review");
  await expect(review.getByRole("heading", { name: "Review the proposed workflow" })).toBeVisible();
  for (const part of ["Name & basics", "Instructions", "Capture fields", "Start form"])
    await expect(review.getByRole("listitem", { name: part })).toBeVisible();

  // Dropping the capture part leaves the start form bound to missing paths: the validator flags it inline and Save is blocked.
  const capture = review.getByRole("listitem", { name: "Capture fields" });
  await capture.getByRole("button", { name: "Drop" }).click();
  await expect(capture).toContainText("Dropped");
  await expect(review.getByRole("alert").first()).toBeVisible();
  await expect(review.getByRole("button", { name: "Save as draft" })).toBeDisabled();
  await capture.getByRole("button", { name: "Keep" }).click();

  // Drop the start form instead; edit the basics so retries don't collide.
  await review.getByRole("listitem", { name: "Start form" }).getByRole("button", { name: "Drop" }).click();
  await renameSlug(page, `lan${nonce}`);
  await expect(review.getByRole("button", { name: "Save as draft" })).toBeEnabled();
  await review.getByRole("button", { name: "Save as draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/lan${nonce}/edit$`));

  const list = await (await page.request.get("/api/workflows")).json();
  const wf = (list.workflows as { slug: string; status: string }[]).find((w) => w.slug === `lan${nonce}`);
  expect(wf?.status).toBe("draft");
});

test("describe it drafts a proposal; test a turn is a discarded sandbox", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/workflows/new");
  // A tap before hydration is lost (seen under parallel CI load): tap again until the form opens.
  const describeIt = page.getByRole("button", { name: "Describe it" });
  await expect(async () => {
    if (await describeIt.isVisible()) await describeIt.click();
    await expect(page.locator("#wf-describe")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await page.locator("#wf-describe").fill("Weekly study group notes: passage, questions, my takeaways.");
  await page.getByRole("button", { name: "Draft it" }).click();
  const review = page.getByTestId("proposal-review");
  await expect(review.getByRole("listitem", { name: "Instructions" })).toContainText("Use my words");
  await renameSlug(page, `des${nonce}`);
  await review.getByRole("button", { name: "Save as draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/des${nonce}/edit$`));

  const runsBefore = await (await page.request.get("/api/workflows/runs")).text();
  const panel = page.getByTestId("builder-test-turn");
  await panel.locator("#wf-test-msg").fill("Grace means undeserved favour");
  await panel.getByRole("button", { name: "Test a turn" }).click();
  await expect(panel).toContainText("Noted: Grace means undeserved favour");
  await expect(panel).toContainText("/takeaways/-");
  await expect(panel).toContainText("Discarded");
  expect(await (await page.request.get("/api/workflows/runs")).text()).toBe(runsBefore);
});
