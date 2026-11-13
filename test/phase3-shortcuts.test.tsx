// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CapturePreview } from "@/components/capture/CapturePreview";
afterEach(cleanup);
// The item page's AI shortcut chips are gone: the AI actions live in one place, the item's ⋯ menu
// (test/item-summary-ui.test.tsx covers its entries).
it("capture preview updates its real title and Inbox destination without inventing a due date", () => {
  const { rerender } = render(<CapturePreview text={"Tune the bandsaw\nNotes"} url="" fileCount={0} />);
  expect(screen.getByTestId("capture-preview").textContent).toBe("Will create: Capture · Tune the bandsaw · Inbox");
  rerender(<CapturePreview text="" url="https://example.com/new" fileCount={0} />);
  expect(screen.getByTestId("capture-preview").textContent).toContain("example.com");
  rerender(<CapturePreview text="" url="" fileCount={1} />);
  expect(screen.getByTestId("capture-preview").textContent).toContain("Screenshot");
});
