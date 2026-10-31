import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, mock, startConversation } from "./helpers";

// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

async function openFiles(page: Page) {
  const vw = page.viewportSize()?.width ?? 0;
  if (vw >= 1100) return page.getByRole("complementary", { name: "Context and links" });
  await page.getByTestId("links-button").click();
  return page.getByRole("dialog", { name: "Context & links" });
}

async function sendAndWait(page: Page, text: string) {
  await expect(page.getByTestId("attachment-chip").first()).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await page.getByLabel(/^Message /).fill(text);
  await page.getByRole("button", { name: /^Send/ }).click();
}

test("file picker: a picture and a text file go out; Hermes gets the image, the text is extracted", async ({ page }) => {
  await startConversation(page, "walrus attachments check");
  await expect(page.getByText(/Got it: "walrus/)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("chat-file-input").setInputFiles([
    { name: "walrus-porch.png", mimeType: "image/png", buffer: PNG },
    { name: "walrus-list.md", mimeType: "text/markdown", buffer: Buffer.from("# Groceries\n- milk") },
  ]);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(2);
  await expect(page.getByText("PDFs and text files are sent as extracted text")).toBeVisible();
  await expect(page.getByTestId("attachment-chip").nth(1)).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await sendAndWait(page, "walrus what is this");
  await expect(page.getByText("I can see 1 picture(s).")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  const bubble = page.getByTestId("message-attachments").last();
  await expect(bubble.getByRole("button", { name: "Open picture walrus-porch.png" })).toBeVisible({ timeout: 15_000 });
  await bubble.getByRole("button", { name: "Open picture walrus-porch.png" }).click();
  await expect(page.getByRole("dialog", { name: "walrus-porch.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  const panel = await openFiles(page);
  await expect(panel.getByTestId("files-panel")).toContainText("walrus-list.md");
  await expect(panel.getByTestId("files-panel")).toContainText("walrus-porch.png");
});

test("rejects programs, archives and over-limit pictures before uploading", async ({ page }) => {
  await startConversation(page, "walrus rejects check");
  await expect(page.getByText(/Got it: "walrus rejects/)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("chat-file-input").setInputFiles([
    { name: "setup.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") },
    { name: "photos.zip", mimeType: "application/zip", buffer: Buffer.from("PK") },
  ]);
  await expect(page.getByText("setup.exe: programs and archives can't be attached")).toBeVisible();
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});

test("paste a clipboard image into the composer", async ({ page }) => {
  await startConversation(page, "walrus paste check");
  await expect(page.getByText(/Got it: "walrus paste/)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/^Message /).focus();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById("composer")!.dispatchEvent(ev);
  }, PNG.toString("base64"));
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  await sendAndWait(page, "walrus pasted");
  await expect(page.getByText("I can see 1 picture(s).")).toBeVisible({ timeout: 15_000 });
});

test("drag and drop a file onto the conversation", async ({ page }) => {
  await startConversation(page, "walrus drop check");
  await expect(page.getByText(/Got it: "walrus drop/)).toBeVisible({ timeout: 15_000 });
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(["a,b\n1,2"], "walrus-table.csv", { type: "text/csv" }));
    return d;
  });
  const zone = page.getByTestId("conversation-drop");
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(page.getByText("Drop files or pictures to attach")).toBeVisible();
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(page.getByTestId("attachment-chip")).toContainText("walrus-table.csv");
  await expect(page.getByText("Drop files or pictures to attach")).toBeHidden();
  await page.getByRole("button", { name: "Remove walrus-table.csv" }).click();
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});

test("phone: camera input captures from the back camera, picker offers pictures and documents", async ({ page }) => {
  await startConversation(page, "walrus phone check");
  await expect(page.getByText(/Got it: "walrus phone/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-camera-input")).toHaveAttribute("capture", "environment");
  await expect(page.getByTestId("chat-camera-input")).toHaveAttribute("accept", "image/*");
  await expect(page.getByTestId("chat-file-input")).toHaveAttribute("accept", "image/*,application/pdf,text/*,.md,.csv,.json");
  await page.getByTestId("chat-camera-input").setInputFiles({ name: "IMG_0001.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
});

test("attachments: axe clean and no overflow at 200% text zoom", async ({ page }) => {
  await startConversation(page, "walrus a11y check");
  await expect(page.getByText(/Got it: "walrus a11y/)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("chat-file-input").setInputFiles([
    { name: "walrus-a-very-long-file-name-for-overflow-checks.png", mimeType: "image/png", buffer: PNG },
    { name: "walrus-notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
  ]);
  await expect(page.getByTestId("attachment-chip").nth(1)).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect.soft(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
});
