import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";
import { stubPhase3Shell } from "./fixtures/phase3-gaps";

test("alder task segments persist in URL, retain due groups, and focus the existing add form", async ({ page }) => {
  await stubPhase3Shell(page);
  const at = new Date().toISOString();
  const base = {
    source: "todos",
    fetchedAt: at,
    updatedAt: at,
    staleAfter: new Date(Date.now() + 3600_000).toISOString(),
    href: "/todos",
    primaryAction: { kind: "open", label: "Open todo" },
  };
  await page.route(/\/api\/sources\/todos(?:\?.*)?$/, (r) =>
    r.fulfill({
      json: {
        status: { source: "todos", label: "Todos", state: "ok", fetchedAt: at },
        data: {
          extra: { provider: "jarvis" },
          actions: [
            { ...base, id: "todos:alder_personal", sourceId: "alder_personal", title: "Alder square the fence", status: "open", priorityReason: "today" },
            {
              ...base,
              id: "todos:alder_waiting",
              sourceId: "alder_waiting",
              title: "Alder await the bearings",
              status: "waiting",
              priorityReason: "upcoming",
              assignee: { kind: "other", name: "Partner" },
            },
            { ...base, id: "todos:alder_done", sourceId: "alder_done", title: "Alder oil the jig", status: "completed", priorityReason: "today" },
          ],
        },
      },
    }),
  );
  await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (r) =>
    r.fulfill({ json: { status: { source: "skylight", label: "Skylight", state: "ok", fetchedAt: at }, data: { actions: [], extra: {} } } }),
  );
  await page.route(/\/api\/settings$/, (r) => r.fulfill({ json: { timezone: "America/Chicago" } }));
  await page.goto("/todos?seg=mine");
  const segment = page.getByRole("radiogroup", { name: "Tasks segment" });
  await expect(segment.getByRole("radio", { name: "Mine", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("region", { name: /^Today/ })).toContainText("Alder square the fence");
  await expect(page.getByRole("region", { name: /^Completed recently/ })).toContainText("Alder oil the jig");
  await expect(page.getByText("Alder await the bearings", { exact: true })).toHaveCount(0);
  await segment.getByRole("radio", { name: "Waiting", exact: true }).click();
  await expect(page).toHaveURL(/seg=waiting/);
  await page.reload();
  await expect(segment.getByRole("radio", { name: "Waiting", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("region", { name: /^Waiting on others/ })).toContainText("Alder await the bearings");
  await segment.getByRole("radio", { name: "All", exact: true }).click();
  await expect(page).not.toHaveURL(/seg=/);
  await expect(segment.getByRole("radio", { name: "AI", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page.getByLabel("New todo", { exact: true })).toBeFocused();
  await expectNoHorizontalOverflow(page);
});
